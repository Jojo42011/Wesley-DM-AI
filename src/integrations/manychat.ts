import { z } from "zod";
import type { InboundEvent } from "../domain/types.js";

/**
 * ManyChat → TikTok webhook adapter.
 *
 * Normalizes snake_case / camelCase variants, validates identity, rejects
 * unresolved ManyChat merge tokens in IDENTITY fields (never in the message
 * body — people are allowed to type braces), and normalizes the legacy
 * `marco_previous_outbound` alias to `wesleyPreviousOutbound` so the legacy
 * name never leaks into domain logic.
 */

export class WebhookRejection extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
  ) {
    super(reason);
  }
}

const RawPayload = z.record(z.unknown());

const UNRESOLVED_TOKEN = /\{\{[^}]*\}\}/;

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (raw[k] !== undefined && raw[k] !== null) return raw[k];
  }
  return undefined;
}

function asTrimmedString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number") return String(v);
  return null;
}

export interface AdapterResult {
  event: InboundEvent;
  fieldsPresent: string[];
}

export function normalizeManyChatPayload(body: unknown): AdapterResult {
  const parsed = RawPayload.safeParse(body);
  if (!parsed.success) {
    throw new WebhookRejection(400, "invalid_json_body");
  }
  const raw = parsed.data;

  const platform = asTrimmedString(pick(raw, "platform"))?.toLowerCase() ?? "tiktok";
  if (platform !== "tiktok") {
    throw new WebhookRejection(400, "unsupported_platform");
  }

  const userId = asTrimmedString(pick(raw, "user_id", "userId", "subscriber_id", "subscriberId"));
  const username = asTrimmedString(pick(raw, "username", "tt_username", "ttUsername"));
  const displayName = asTrimmedString(pick(raw, "display_name", "displayName", "full_name", "fullName"));
  const message = asTrimmedString(pick(raw, "message", "last_text_input", "lastTextInput", "text")) ?? "";
  const messageId = asTrimmedString(pick(raw, "message_id", "messageId"));
  const conversationGoal = asTrimmedString(pick(raw, "conversation_goal", "conversationGoal"));
  const sourceCampaign = asTrimmedString(pick(raw, "source_campaign", "sourceCampaign"));
  const flowKey = asTrimmedString(pick(raw, "flow_key", "flowKey", "flow"));

  // Canonical field with legacy migration alias — normalized immediately;
  // the legacy name must never appear in domain logic.
  const wesleyPreviousOutbound =
    asTrimmedString(pick(raw, "wesley_previous_outbound", "wesleyPreviousOutbound")) ??
    asTrimmedString(pick(raw, "marco_previous_outbound", "marcoPreviousOutbound"));

  const isEcho = pick(raw, "is_echo", "isEcho", "echo") === true;

  // Identity priority is configurable: prefer stable subscriber/contact IDs
  // over mutable usernames when present.
  const stableId = userId ?? username;
  if (!stableId) {
    throw new WebhookRejection(400, "missing_user_identity");
  }

  // Reject unresolved ManyChat merge tokens in identity fields ONLY.
  for (const [name, value] of [
    ["user_id", userId],
    ["username", username],
    ["display_name", displayName],
  ] as const) {
    if (value && UNRESOLVED_TOKEN.test(value)) {
      throw new WebhookRejection(400, `unresolved_manychat_token:${name}`);
    }
  }

  const fieldsPresent = Object.keys(raw).filter((k) => raw[k] !== undefined && raw[k] !== null);

  return {
    event: {
      platform: "tiktok",
      externalUserId: stableId,
      username,
      displayName,
      message,
      providerMessageId: messageId,
      wesleyPreviousOutbound,
      conversationGoal,
      sourceCampaign,
      flowKey,
      isEcho,
    },
    fieldsPresent,
  };
}

/**
 * Idempotency key: provider message ID when available; otherwise a bounded
 * fallback from platform + stable user id + normalized message + time bucket.
 */
export function idempotencyKey(event: InboundEvent, bucketSeconds = 90): string {
  if (event.providerMessageId) {
    return `tiktok:msg:${event.providerMessageId}`;
  }
  const normalized = event.message.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  const bucket = Math.floor(Date.now() / 1000 / bucketSeconds);
  return `tiktok:fb:${event.externalUserId}:${bucket}:${normalized}`;
}
