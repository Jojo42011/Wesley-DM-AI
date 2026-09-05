import { randomUUID } from "node:crypto";
import { createLogger, preview } from "../observability/logger.js";
import { idempotencyKey } from "../integrations/manychat.js";
import {
  normalizeRespondIoPayload,
  payloadKeyPaths,
  RespondIoRejection,
  type RespondIoClient,
} from "../integrations/respondio.js";
import { processInboundEvent, recordOutboundMessage, type PipelineDeps } from "./dmPipeline.js";

export interface RespondIoWebhookDeps extends PipelineDeps {
  respondIo: RespondIoClient;
  /** Wesley's TikTok channel id; resolved at boot. Null disables id filtering. */
  tiktokChannelId: number | null;
  /** Shared secret required as a query param or header, when configured. */
  webhookSecret?: string | null;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * POST /webhook/respondio — respond.io "New Incoming Message" webhook.
 *
 * respond.io does not read a reply from this response, so the flow is:
 * normalize -> filter to TikTok -> drop echoes (after recording them) ->
 * run the existing Wesley pipeline -> deliver the reply through the
 * Developer API.
 */
export async function handleRespondIoWebhook(
  deps: RespondIoWebhookDeps,
  rawBody: unknown,
  context: { secret?: string | null } = {},
): Promise<WebhookResponse> {
  const requestId = randomUUID();
  const logger = createLogger({ requestId, transport: "respondio" });

  if (deps.webhookSecret && context.secret !== deps.webhookSecret) {
    logger.log("inbound_rejected", { reason: "bad_webhook_secret" });
    return { status: 401, body: { error: "unauthorized" } };
  }

  let parsed;
  try {
    parsed = normalizeRespondIoPayload(rawBody, { tiktokChannelId: deps.tiktokChannelId });
  } catch (err) {
    if (err instanceof RespondIoRejection) {
      logger.log("inbound_rejected", {
        reason: err.reason,
        keyPaths: payloadKeyPaths(rawBody),
      });
      return { status: err.statusCode, body: { error: err.reason } };
    }
    logger.log("pipeline_error", { error: err instanceof Error ? err.message : "unknown" });
    return { status: 400, body: { error: "invalid_payload" } };
  }

  /* ---------------------------------------------------- ignored events */
  if (parsed.kind === "ignore") {
    // Channel filtering is routine; an unrecognized shape is not, so that
    // case carries the payload's structure for diagnosis.
    const unexpected = /unidentified_channel|non_text_message/.test(parsed.reason);
    logger.log("inbound_rejected", {
      reason: parsed.reason,
      ...(unexpected ? { keyPaths: payloadKeyPaths(rawBody) } : {}),
    });
    return { status: 200, body: { ok: true, ignored: parsed.reason } };
  }

  /* ------------- outbound echo: record it, never reply to ourselves ---- */
  if (parsed.kind === "outbound") {
    try {
      const result = await recordOutboundMessage(
        { store: deps.store, logger },
        {
          externalUserId: `respondio:${parsed.contactId}`,
          text: parsed.text,
          providerMessageId: parsed.providerMessageId,
          campaignKey: "respondio_tiktok",
        },
      );
      return { status: 200, body: { ok: true, outbound: result.reason } };
    } catch (err) {
      logger.log("pipeline_error", {
        error: err instanceof Error ? err.message : "unknown",
        phase: "record_outbound",
      });
      return { status: 200, body: { ok: true, outbound: "record_failed" } };
    }
  }

  /* ----------------------------- inbound: the real turn --------------- */
  const { event, contactId, channelId } = parsed;
  const idemKey = idempotencyKey(event);

  try {
    const outcome = await processInboundEvent({ ...deps, logger }, event);

    if (!outcome.reply) {
      logger.log("pipeline_complete", {
        decision: outcome.decision,
        delivered: false,
        transport: "respondio",
      });
      return { status: 200, body: { ok: true, replied: false, decision: outcome.decision } };
    }

    const sent = await deps.respondIo.sendText(contactId, outcome.reply, {
      channelId: channelId ?? deps.tiktokChannelId,
    });

    if (sent.ok) {
      logger.log("reply_generated", {
        leadId: outcome.leadId,
        delivered: true,
        length: outcome.reply.length,
        preview: preview(outcome.reply),
      });
      return { status: 200, body: { ok: true, replied: true } };
    }

    // The reply exists and is stored, but respond.io would not take it.
    // Non-2xx tells respond.io to retry the webhook; our idempotency layer
    // will short-circuit the duplicate and we surface the failure in logs.
    logger.log("pipeline_error", {
      leadId: outcome.leadId,
      phase: "delivery",
      status: sent.status,
      detail: sent.detail,
    });
    return { status: 502, body: { error: "delivery_failed", detail: sent.detail } };
  } catch (err) {
    // Processing blew up before a reply existed. Release the idempotency
    // claim so a respond.io retry is genuinely reprocessed instead of being
    // silently swallowed as a duplicate.
    await deps.store.idempotency.release(idemKey).catch(() => {});
    logger.log("pipeline_error", {
      error: err instanceof Error ? err.message : "unknown",
      phase: "pipeline",
      released: true,
    });
    return { status: 500, body: { error: "processing_failed" } };
  }
}
