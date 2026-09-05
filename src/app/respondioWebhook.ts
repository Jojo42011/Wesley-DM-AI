import { randomUUID } from "node:crypto";
import { createLogger, preview, type Logger } from "../observability/logger.js";
import { idempotencyKey } from "../integrations/manychat.js";
import {
  normalizeRespondIoPayload,
  payloadKeyPaths,
  peekChannel,
  verifyWebhookSignature,
  RespondIoRejection,
  type RespondIoClient,
  type TikTokChannelResolver,
} from "../integrations/respondio.js";
import { processInboundEvent, recordOutboundMessage, type PipelineDeps } from "./dmPipeline.js";

export interface RespondIoWebhookDeps extends PipelineDeps {
  respondIo: RespondIoClient;
  /** Resolves which channels are TikTok, refreshing when one is unknown. */
  channels: TikTokChannelResolver;
  /** respond.io webhook signing key; when set, signatures are required. */
  signingKey?: string | null;
  /** Simple shared secret alternative (?secret= or X-Webhook-Secret). */
  webhookSecret?: string | null;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
  /**
   * Work still running after the response. respond.io times a webhook out at
   * 5 seconds and disables an endpoint after 30 errors in 30 minutes, so the
   * turn is acknowledged immediately and the pipeline runs behind it. Tests
   * await this; production lets it settle on its own.
   */
  processing?: Promise<void>;
}

export interface WebhookContext {
  secret?: string | null;
  signature?: string | null;
  rawBody?: string | null;
}

export async function handleRespondIoWebhook(
  deps: RespondIoWebhookDeps,
  rawBody: unknown,
  context: WebhookContext = {},
): Promise<WebhookResponse> {
  const requestId = randomUUID();
  const logger = createLogger({ requestId, transport: "respondio" });

  /* ------------------------------------------------------ authentication */
  if (deps.signingKey) {
    const body = context.rawBody ?? JSON.stringify(rawBody);
    if (!verifyWebhookSignature(body, context.signature, deps.signingKey)) {
      logger.log("inbound_rejected", { reason: "bad_signature" });
      return { status: 401, body: { error: "unauthorized" } };
    }
  } else if (deps.webhookSecret && context.secret !== deps.webhookSecret) {
    logger.log("inbound_rejected", { reason: "bad_webhook_secret" });
    return { status: 401, body: { error: "unauthorized" } };
  }

  /* --------------------------------------------------- channel filtering */
  const peeked = peekChannel(rawBody);
  if (!(await deps.channels.isTikTok(peeked.id, peeked.source))) {
    logger.log("inbound_rejected", {
      reason: `other_channel:${peeked.source ?? peeked.id ?? "unknown"}`,
      ...(peeked.source || peeked.id ? {} : { keyPaths: payloadKeyPaths(rawBody) }),
    });
    return { status: 200, body: { ok: true, ignored: "other_channel" } };
  }

  let parsed;
  try {
    parsed = normalizeRespondIoPayload(rawBody, { tiktokChannelIds: deps.channels.current() });
  } catch (err) {
    if (err instanceof RespondIoRejection) {
      logger.log("inbound_rejected", { reason: err.reason, keyPaths: payloadKeyPaths(rawBody) });
      return { status: err.statusCode, body: { error: err.reason } };
    }
    logger.log("pipeline_error", { error: err instanceof Error ? err.message : "unknown" });
    return { status: 400, body: { error: "invalid_payload" } };
  }

  if (parsed.kind === "ignore") {
    const unexpected = /unidentified_channel|non_text_message/.test(parsed.reason);
    logger.log("inbound_rejected", {
      reason: parsed.reason,
      ...(unexpected ? { keyPaths: payloadKeyPaths(rawBody) } : {}),
    });
    return { status: 200, body: { ok: true, ignored: parsed.reason } };
  }

  /* ------------- outbound echo: record it, never reply to ourselves ---- */
  if (parsed.kind === "outbound") {
    const { contactId, text, providerMessageId } = parsed;
    const processing = recordOutboundMessage(
      { store: deps.store, logger },
      {
        externalUserId: `respondio:${contactId}`,
        text,
        providerMessageId,
        campaignKey: "respondio_tiktok",
      },
    )
      .then(() => undefined)
      .catch((err: unknown) => {
        logger.log("pipeline_error", {
          error: err instanceof Error ? err.message : "unknown",
          phase: "record_outbound",
        });
      });
    return { status: 200, body: { ok: true, accepted: "outbound" }, processing };
  }

  /* ----------------------------- inbound: the real turn --------------- */
  const processing = runTurn(deps, logger, parsed).catch((err: unknown) => {
    logger.log("pipeline_error", {
      error: err instanceof Error ? err.message : "unknown",
      phase: "background",
    });
  });

  return { status: 200, body: { ok: true, accepted: "inbound" }, processing };
}

/**
 * The actual turn, run after the webhook has already been acknowledged:
 * recover a manual opener if we have none, run the unchanged pipeline, then
 * deliver the reply through respond.io.
 */
async function runTurn(
  deps: RespondIoWebhookDeps,
  logger: Logger,
  parsed: Extract<Awaited<ReturnType<typeof normalizeRespondIoPayload>>, { kind: "inbound" }>,
): Promise<void> {
  const { event, contactId, channelId } = parsed;
  const idemKey = idempotencyKey(event);

  try {
    // If this contact has no history with us, Wesley may have opened the
    // conversation manually before the webhook was connected. Pull his last
    // outbound message so the agent continues rather than reintroducing.
    const known = await deps.store.leads.findByExternalId("tiktok", event.externalUserId);
    if (!known || (await deps.store.conversations.countAssistantMessages(known.id)) === 0) {
      const opener = await deps.respondIo.findLastOutboundText(contactId).catch(() => null);
      if (opener) {
        event.wesleyPreviousOutbound = opener;
        logger.log("manual_opener_seeded", { source: "history_fetch", preview: preview(opener) });
      }
    }

    const outcome = await processInboundEvent({ ...deps, logger }, event);

    if (!outcome.reply) {
      logger.log("pipeline_complete", { decision: outcome.decision, delivered: false });
      return;
    }

    const sent = await deps.respondIo.sendText(contactId, outcome.reply, {
      channelId: channelId ?? deps.channels.current()[0] ?? null,
    });

    if (sent.ok) {
      logger.log("reply_generated", {
        leadId: outcome.leadId,
        delivered: true,
        length: outcome.reply.length,
        preview: preview(outcome.reply),
      });
    } else {
      logger.log("pipeline_error", {
        leadId: outcome.leadId,
        phase: "delivery",
        status: sent.status,
        detail: sent.detail,
      });
    }
  } catch (err) {
    // Nothing was delivered. Release the idempotency claim so the same
    // message can be reprocessed instead of being swallowed as a duplicate.
    await deps.store.idempotency.release(idemKey).catch(() => {});
    logger.log("pipeline_error", {
      error: err instanceof Error ? err.message : "unknown",
      phase: "pipeline",
      released: true,
    });
  }
}
