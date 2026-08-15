import { randomUUID } from "node:crypto";
import { normalizeManyChatPayload, WebhookRejection } from "../integrations/manychat.js";
import { createLogger } from "../observability/logger.js";
import { processInboundEvent, type PipelineDeps } from "./dmPipeline.js";

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * POST /webhook/tiktok — the ManyChat entry point.
 * Returns { reply } for ManyChat to send, or { reply: null } for silence.
 */
export async function handleTikTokWebhook(
  deps: PipelineDeps,
  rawBody: unknown,
): Promise<WebhookResponse> {
  const requestId = randomUUID();
  const logger = createLogger({ requestId });

  let adapterResult;
  try {
    adapterResult = normalizeManyChatPayload(rawBody);
  } catch (err) {
    if (err instanceof WebhookRejection) {
      logger.log("inbound_rejected", { reason: err.reason });
      return { status: err.statusCode, body: { error: err.reason } };
    }
    logger.log("pipeline_error", { error: err instanceof Error ? err.message : "unknown" });
    return { status: 400, body: { error: "invalid_payload" } };
  }

  // Log which fields were present — never secrets or message bodies.
  logger.log("inbound_accepted", { fieldsPresent: adapterResult.fieldsPresent });

  try {
    const outcome = await processInboundEvent(
      { ...deps, logger },
      adapterResult.event,
    );
    return { status: 200, body: { reply: outcome.reply } };
  } catch (err) {
    logger.log("pipeline_error", {
      error: err instanceof Error ? err.message : "unknown",
    });
    // Never crash the connector — ManyChat treats null reply as silence.
    return { status: 200, body: { reply: null } };
  }
}
