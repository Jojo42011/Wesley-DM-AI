/**
 * POST /api/zernio/webhook — inbound TikTok DMs from the Zernio inbox.
 *
 * SHAPE OF THIS HANDLER, and why it is not like the ManyChat one. ManyChat
 * called us and sent whatever we returned in the response body, so that handler
 * could take as long as the pipeline took. Zernio expects a 2xx within FIVE
 * SECONDS and then we call it back to deliver the reply. Wesley's turn holds a
 * four second batching window and then makes two Anthropic calls, so answering
 * inline would miss that budget on nearly every turn and earn a retry. A
 * retried inbound is a duplicate DM, which is the failure this codebase spends
 * the most code preventing.
 *
 * So the order is fixed and the cheap half is everything before the ack:
 *
 *   1. webhook secret configured?     no -> 503, fail closed
 *   2. X-Zernio-Signature valid?      no -> 401
 *   3. body parses as JSON?           no -> 400
 *   4. comment.received?              yes -> ack, comment agent after
 *   5. an actionable message.received?  no -> 200 ignored (never retry this)
 *   6. our TikTok account?            no -> 200 ignored, account isolation
 *   7. event already seen?            yes -> 200 duplicate
 *   8. ACK 200. Everything after this line runs off the response.
 *
 * Steps 1 to 6 are a hash, a JSON.parse and one indexed SQLite write. Opener
 * recovery, batching, the pipeline and the outbound send all live after step 7.
 *
 * NOTHING IN THE PIPELINE CHANGED FOR THIS. The Zernio payload is mapped onto
 * the same InboundEvent the ManyChat adapter produces and handed to
 * processInboundEvent unmodified, so the intent gate, the funnel, the guards,
 * phone extraction, the validator and the CRM handoff all behave exactly as
 * they did.
 *
 * DEDUPE IS TWO LAYERED CLAIMS ON PURPOSE, keyed differently so neither can
 * cancel the other:
 *   - here, on Zernio's own event id, which catches a webhook redelivery before
 *     any work happens
 *   - in the pipeline, on the provider message id, which catches the same
 *     message arriving by any route at all
 * plus an Idempotency-Key on the send, so even a duplicate that somehow reached
 * the pipeline twice could not put two DMs in the thread.
 */
import { randomUUID } from "node:crypto";
import type { InboundEvent, PipelineOutcome } from "../domain/types.js";
import { createLogger, preview, type Logger } from "../observability/logger.js";
import { processInboundEvent, type PipelineDeps } from "./dmPipeline.js";
import { InboundBatcher, DEFAULT_DEBOUNCE_MS } from "./messageDebounce.js";
import {
  accountMatches,
  fetchManualOpener,
  parseZernioInboundMessage,
  sendZernioReply,
  verifyZernioSignature,
  zernioTikTokAccountId,
  zernioWebhookSecretConfigured,
  type ZernioInboundMessage,
  type ZernioSendResult,
} from "../integrations/zernio/dm.js";
import { parseZernioInboundComment } from "../integrations/zernio/comments.js";
import { handleInboundComment } from "../agents/commentAgent/index.js";
import { markCommenterDmReceived } from "../persistence/commentAgentStore.js";

/** Seven days, matching the pipeline's own idempotency horizon. */
const EVENT_DEDUPE_TTL_SECONDS = 7 * 24 * 3600;

/**
 * The parts of Zernio this handler touches, injected so tests can drive the
 * whole route without a network. Production passes nothing and gets the real
 * module functions.
 */
export interface ZernioTransport {
  fetchManualOpener: typeof fetchManualOpener;
  sendZernioReply: typeof sendZernioReply;
}

const REAL_TRANSPORT: ZernioTransport = { fetchManualOpener, sendZernioReply };

export interface ZernioWebhookDeps {
  pipeline: PipelineDeps;
  transport?: ZernioTransport;
  logger?: Logger;
  /** Batching window. Tests shorten it; production uses the four second one. */
  debounceMs?: number;
}

export interface ZernioAck {
  status: number;
  body: Record<string, unknown>;
  /**
   * The work that runs AFTER the response. The server voids this; tests await
   * it. Null whenever the request was refused or ignored, which is also how a
   * test asserts that nothing was processed.
   */
  processing: Promise<void> | null;
}

/** Map a Zernio event onto the InboundEvent the pipeline already takes. */
export function toInboundEvent(evt: ZernioInboundMessage, manualOpener: string | null): InboundEvent {
  return {
    platform: "tiktok",
    /* The sender's stable platform id, never the username: a username can be
       changed and would split or merge threads. */
    externalUserId: evt.senderId,
    username: evt.senderUsername,
    displayName: evt.senderName,
    message: evt.text,
    providerMessageId: evt.platformMessageId ?? evt.eventId,
    wesleyPreviousOutbound: manualOpener,
    conversationGoal: null,
    sourceCampaign: null,
    flowKey: null,
    /* Outgoing echoes never reach here; the parser refuses them by direction. */
    isEcho: false,
    transport: "tiktok_zernio",
  };
}

/**
 * One batcher per process, keyed by conversation. Built lazily because the
 * batching window is a dependency and tests want a short one.
 */
export class ZernioWebhookHandler {
  private readonly deps: ZernioWebhookDeps;
  private readonly transport: ZernioTransport;
  private readonly batcher: InboundBatcher;

  constructor(deps: ZernioWebhookDeps) {
    this.deps = deps;
    this.transport = deps.transport ?? REAL_TRANSPORT;
    this.batcher = new InboundBatcher({
      waitMs: deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      process: (combined) => this.runPipeline(combined),
    });
  }

  private runPipeline(event: InboundEvent): Promise<PipelineOutcome> {
    return processInboundEvent(this.deps.pipeline, event);
  }

  /**
   * Handle one delivery. Returns as soon as the ack is decided; the caller
   * writes the response and lets `processing` run unawaited.
   */
  async handle(input: { rawBody: Buffer; signature: string | null }): Promise<ZernioAck> {
    const requestId = randomUUID();
    const logger = (this.deps.logger ?? createLogger({ requestId })).child({ transport: "zernio" });

    /* 1. Fail closed. This endpoint creates leads and sends real DMs; an unset
       secret must close it, not open it. 503 rather than 401 so the cause reads
       as "this server is not configured" and not "your signature is wrong". */
    if (!zernioWebhookSecretConfigured()) {
      logger.log("inbound_rejected", { reason: "zernio_secret_not_configured" });
      return {
        status: 503,
        body: {
          ok: false,
          error:
            "ZERNIO_WEBHOOK_SECRET is not set on this server, so the Zernio webhook is closed. " +
            "Set it as a secret and register the same value on the Zernio webhook.",
        },
        processing: null,
      };
    }

    /* 2. Signature over the RAW bytes. */
    if (!verifyZernioSignature(input.rawBody, input.signature)) {
      logger.log("inbound_rejected", { reason: "zernio_bad_signature" });
      return {
        status: 401,
        body: { ok: false, error: "Bad or missing X-Zernio-Signature" },
        processing: null,
      };
    }

    /* 3. Parse only after the signature has cleared. */
    let body: unknown;
    try {
      body = JSON.parse(input.rawBody.toString("utf8"));
    } catch {
      logger.log("inbound_rejected", { reason: "zernio_malformed_json" });
      return { status: 400, body: { ok: false, error: "Body is not valid JSON" }, processing: null };
    }

    /* 4. Comment agent first — cheaper check, never overlaps with DMs. */
    const commentEvt = parseZernioInboundComment(body);
    if (commentEvt) {
      if (commentEvt.accountId && !accountMatches(commentEvt.accountId)) {
        logger.log("inbound_rejected", { reason: "zernio_comment_account_mismatch" });
        return {
          status: 200,
          body: { ok: true, ignored: true, reason: "account_mismatch" },
          processing: null,
        };
      }
      const accountId = zernioTikTokAccountId() || commentEvt.accountId || "";
      if (!accountId) {
        logger.log("inbound_rejected", { reason: "zernio_account_not_configured" });
        return {
          status: 200,
          body: { ok: true, ignored: true, reason: "account_not_configured" },
          processing: null,
        };
      }
      logger.log("inbound_accepted", {
        kind: "comment",
        commentId: commentEvt.commentId,
        preview: preview(commentEvt.text),
      });
      return {
        status: 200,
        body: { ok: true },
        processing: (async () => {
          try {
            const outcome = await handleInboundComment(commentEvt, accountId);
            logger.log("comment_agent_outcome", {
              commentId: commentEvt.commentId,
              decision: outcome.decision,
              bucket: outcome.bucket,
              reason: outcome.reason,
            });
          } catch (err) {
            logger.log("pipeline_error", {
              stage: "zernio_comment",
              error: err instanceof Error ? err.message : "unknown",
            });
          }
        })(),
      };
    }

    /* 5. Not actionable DM: a different event type, our own outgoing echo, a
       non-TikTok message, or a payload with no sender. All 200, because Zernio
       must not retry something we have correctly decided to ignore. */
    const parsed = parseZernioInboundMessage(body);
    if (!parsed.ok) {
      logger.log("inbound_rejected", { reason: `zernio_${parsed.reason}` });
      return { status: 200, body: { ok: true, ignored: true, reason: parsed.reason }, processing: null };
    }
    const evt = parsed.event;

    /* 5. Account isolation. This Zernio profile can carry more than one
       connected account; only Wesley's may reach Wesley's pipeline. Unset
       ZERNIO_TIKTOK_ACCOUNT_ID matches nothing at all, so a misconfigured
       server ignores traffic rather than answering someone else's leads. */
    if (!accountMatches(evt.accountId)) {
      logger.log("inbound_rejected", {
        reason: zernioTikTokAccountId() ? "zernio_account_mismatch" : "zernio_account_not_configured",
      });
      return {
        status: 200,
        body: { ok: true, ignored: true, reason: "account_mismatch" },
        processing: null,
      };
    }

    /* 6. Webhook-level dedupe on Zernio's event id. Distinct from the
       pipeline's claim on the provider message id, so the two never cancel. */
    const fresh = await this.deps.pipeline.store.idempotency.claim(
      `zernio:evt:${evt.eventId}`,
      EVENT_DEDUPE_TTL_SECONDS,
    );
    if (!fresh) {
      logger.log("inbound_rejected", { reason: "zernio_duplicate_event" });
      return { status: 200, body: { ok: true, duplicate: true }, processing: null };
    }

    logger.log("inbound_accepted", {
      conversationId: evt.conversationId,
      messageChars: evt.text.length,
      preview: preview(evt.text),
      usernameSet: Boolean(evt.senderUsername),
    });

    /* 7. Ack. Everything below runs off the response. */
    return {
      status: 200,
      body: { ok: true },
      processing: this.processAfterAck(evt, logger),
    };
  }

  /**
   * The slow half: recover the opener, batch, run the pipeline, deliver.
   * Never throws — a rejection here would be an unhandled rejection on a
   * promise the server deliberately does not await.
   */
  private async processAfterAck(evt: ZernioInboundMessage, logger: Logger): Promise<void> {
    try {
      /* Close the comment→DM loop: TikTok author id === DM sender id. */
      try {
        const attributed = markCommenterDmReceived(evt.senderId);
        if (attributed > 0) {
          logger.log("comment_to_dm_converted", {
            authorId: evt.senderId.slice(0, 8),
            commentRowsMarked: attributed,
          });
        }
      } catch {
        /* Ledger optional for the DM turn — never block a reply. */
      }

      /* Zernio has no "previous outbound" field, so the VA's manual opener is
         read back off the conversation. A failure costs the model one piece of
         context; it must never cost the lead their reply. fetchManualOpener
         already swallows its own errors, but the turn is not allowed to depend
         on that: a throw here degrades to "no opener" and the turn continues. */
      let manualOpener: string | null = null;
      try {
        manualOpener = await this.transport.fetchManualOpener({
          conversationId: evt.conversationId,
          accountId: evt.accountId,
          beforeMessageId: evt.platformMessageId,
        });
      } catch (err) {
        logger.log("pipeline_error", {
          stage: "zernio_opener_lookup",
          error: err instanceof Error ? err.message : "unknown",
        });
      }

      const event = toInboundEvent(evt, manualOpener);
      const batch = await this.batcher.submit(`tiktok:${evt.senderId}`, event);

      /* Every provider message id in the batch that is not the one the pipeline
         itself claimed gets claimed here, so a later redelivery of an earlier
         message in the burst cannot reopen a turn that has already been
         answered. */
      for (const id of batch.providerMessageIds) {
        if (id === event.providerMessageId) continue;
        await this.deps.pipeline.store.idempotency
          .claim(`tiktok:msg:${id}`, EVENT_DEDUPE_TTL_SECONDS)
          .catch(() => false);
      }

      if (!batch.leader) {
        /* Folded into a burst that another delivery is answering. Sending
           anything here would put two DMs in the thread. */
        logger.log("reply_suppressed", {
          reason: "batched_into_later_message",
          batched: batch.batched,
        });
        return;
      }

      if (batch.batched > 1) {
        logger.log("messages_batched", {
          batched: batch.batched,
          providerMessageIds: batch.providerMessageIds.length,
        });
      }

      const reply = batch.outcome?.reply?.trim();
      if (!reply) {
        /* A null reply is a decision, not a failure: silence after an ack, an
           opt-out, a suppressed duplicate. Nothing is sent. */
        logger.log("reply_suppressed", {
          reason: "no_reply",
          decision: batch.outcome?.decision ?? "no_outcome",
        });
        return;
      }

      const send: ZernioSendResult = await this.transport.sendZernioReply({
        conversationId: evt.conversationId,
        accountId: evt.accountId,
        text: reply,
        /* Keyed on the inbound event, so a retry of the same inbound replays
           the original send rather than delivering a second DM. */
        idempotencyKey: `zernio:${evt.eventId}`,
      });

      logger.log("zernio_reply_send", {
        conversationId: evt.conversationId,
        status: send.status,
        replyChars: reply.length,
        success: send.success,
        windowClosed: send.windowClosed ?? false,
        error: send.error ?? null,
      });

      if (!send.success) {
        /* Named explicitly so the likeliest real cause does not read as a bug
           in the agent: TikTok's 48 hour / 10 message reply window closing
           means the lead went quiet too long, and a human has to reopen the
           thread. Everything else is a transport fault worth paging on. */
        console.error(
          send.windowClosed
            ? `[zernio] TikTok refused the reply to conversation ${evt.conversationId}: ` +
                `the 48 hour messaging window is closed (HTTP ${send.status})`
            : `[zernio] reply NOT delivered to conversation ${evt.conversationId} ` +
                `(HTTP ${send.status}): ${send.error ?? "unknown"}`,
        );
      }
    } catch (err) {
      logger.log("pipeline_error", {
        stage: "zernio_after_ack",
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
}
