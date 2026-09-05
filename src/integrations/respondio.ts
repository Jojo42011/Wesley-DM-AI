import { z } from "zod";
import type { InboundEvent } from "../domain/types.js";

/**
 * respond.io transport adapter.
 *
 * respond.io is the TikTok inbox and delivery transport ONLY. It replaces
 * ManyChat at the edges: inbound webhooks come in here and outbound replies
 * go out through the Developer API. The Wesley pipeline (voice, intent gate,
 * funnel, phone extraction, CRM handoff) is untouched and remains the brain.
 *
 * Unlike ManyChat, respond.io does NOT take the reply from the webhook
 * response body. We acknowledge the webhook and deliver the reply with a
 * separate authenticated API call.
 *
 * Verified live against the account (2026-09):
 *   base URL       https://api.respond.io/v2
 *   auth           Authorization: Bearer <RESPONDIO_API_TOKEN>
 *   channels       GET  /space/channel  ->
 *                  {"items":[{"id":551174,"name":"TikTok Business messaging",
 *                             "source":"tiktok_business", ...}]}
 *   contact by id  GET  /contact/id:<id>
 *   send message   POST /contact/id:<id>/message
 */

export const RESPONDIO_BASE_URL = process.env.RESPONDIO_BASE_URL ?? "https://api.respond.io/v2";

/** Channel `source` values that count as Wesley's TikTok inbox. */
const TIKTOK_SOURCES = new Set(["tiktok", "tiktok_business", "tiktok_business_messaging"]);

export class RespondIoRejection extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
  ) {
    super(reason);
  }
}

/* ------------------------------------------------------------------ types */

/**
 * Parsed webhook. `kind` tells the caller what to do:
 *  - "inbound"  run the pipeline and reply
 *  - "outbound" a message Wesley (or we) sent; record it, never reply
 *  - "ignore"   not our channel / not a text message / unsupported event
 */
export type RespondIoEvent =
  | { kind: "inbound"; event: InboundEvent; contactId: string; channelId: number | null }
  | {
      kind: "outbound";
      contactId: string;
      text: string;
      providerMessageId: string | null;
      channelId: number | null;
    }
  | { kind: "ignore"; reason: string };

const Payload = z.record(z.unknown());

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number") return String(v);
  return null;
}

function pick(source: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const k of keys) {
    if (source[k] !== undefined && source[k] !== null) return source[k];
  }
  return undefined;
}

/**
 * Structural fingerprint of a payload: dotted key paths only, never values.
 * Logged when a payload is not understood, so a respond.io schema change can
 * be diagnosed from production logs without exposing anyone's message text.
 */
export function payloadKeyPaths(value: unknown, prefix = "", depth = 0): string[] {
  if (depth > 3) return [];
  const o = obj(value);
  if (!o) return [];
  const paths: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${k}` : k;
    paths.push(path);
    if (obj(v)) paths.push(...payloadKeyPaths(v, path, depth + 1));
  }
  return paths.slice(0, 60);
}

/* --------------------------------------------------------------- adapter */

/**
 * Normalizes a respond.io "New Incoming Message" webhook into the event the
 * existing pipeline already understands. Field names are read tolerantly
 * (snake_case and camelCase, nested or flat) so a payload revision on
 * respond.io's side does not silently break the funnel.
 */
export function normalizeRespondIoPayload(
  body: unknown,
  opts: { tiktokChannelId?: number | null } = {},
): RespondIoEvent {
  const parsed = Payload.safeParse(body);
  if (!parsed.success) throw new RespondIoRejection(400, "invalid_json_body");
  const raw = parsed.data;

  const eventType = str(pick(raw, "event_type", "eventType", "event", "type"))?.toLowerCase() ?? "";
  const contact = obj(pick(raw, "contact")) ?? obj(pick(raw, "data"));
  const message = obj(pick(raw, "message")) ?? obj(pick(raw, "data"));
  const channel = obj(pick(raw, "channel"));

  // Some event types never carry a message (contact updates, assignments...).
  if (eventType && !/message/.test(eventType) && !message) {
    return { kind: "ignore", reason: `unsupported_event:${eventType}` };
  }

  /* -------- channel filter: Wesley's TikTok inbox only */
  const channelId =
    Number(str(pick(channel, "id", "channelId")) ?? str(pick(message, "channelId", "channel_id"))) ||
    null;
  const channelSource = str(pick(channel, "source", "type", "channelSource"))?.toLowerCase() ?? null;

  const expectedId = opts.tiktokChannelId ?? null;
  if (expectedId !== null && channelId !== null && channelId !== expectedId) {
    return { kind: "ignore", reason: `other_channel_id:${channelId}` };
  }
  if (channelSource && !TIKTOK_SOURCES.has(channelSource)) {
    return { kind: "ignore", reason: `other_channel_source:${channelSource}` };
  }
  // No channel information at all and no configured id: refuse to guess.
  if (expectedId === null && channelId === null && !channelSource) {
    return { kind: "ignore", reason: "unidentified_channel" };
  }

  /* -------- identity: respond.io contact id is the stable key */
  const contactId =
    str(pick(contact, "id", "contactId", "contact_id")) ??
    str(pick(message, "contactId", "contact_id"));
  if (!contactId) throw new RespondIoRejection(400, "missing_contact_id");

  /* -------- message body */
  const inner = obj(pick(message, "message")) ?? message;
  const messageType = str(pick(inner, "type"))?.toLowerCase() ?? "text";
  const text =
    str(pick(inner, "text", "body", "caption")) ??
    str(pick(message, "text", "body"));

  const providerMessageId =
    str(pick(message, "messageId", "message_id", "id")) ??
    str(pick(message, "channelMessageId", "channel_message_id")) ??
    str(pick(raw, "event_id", "eventId"));

  /* -------- direction: outbound events are echoes, never replied to */
  const traffic = str(pick(message, "traffic", "direction"))?.toLowerCase() ?? null;
  const isEchoFlag = pick(message, "isEcho", "is_echo", "echo") === true;
  const outboundByEvent = /(message\.sent|message_sent|outgoing|sent)/.test(eventType);
  const isOutbound =
    isEchoFlag ||
    traffic === "outgoing" ||
    traffic === "outbound" ||
    traffic === "out" ||
    outboundByEvent;

  if (isOutbound) {
    // Wesley's manual messages (and our own delivered replies) come back
    // here. The caller records them so the thread stays accurate.
    return text
      ? { kind: "outbound", contactId, text, providerMessageId, channelId }
      : { kind: "ignore", reason: "outbound_non_text" };
  }

  if (!text) {
    return { kind: "ignore", reason: `non_text_message:${messageType}` };
  }

  const firstName = str(pick(contact, "firstName", "first_name"));
  const lastName = str(pick(contact, "lastName", "last_name"));
  const displayName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const username =
    str(pick(contact, "username", "handle", "channelUsername")) ?? null;

  return {
    kind: "inbound",
    contactId,
    channelId,
    event: {
      platform: "tiktok",
      // The respond.io contact id is stable across username changes.
      externalUserId: `respondio:${contactId}`,
      username,
      displayName,
      message: text,
      providerMessageId: providerMessageId ? `respondio:${providerMessageId}` : null,
      wesleyPreviousOutbound: null, // recovered from stored history, not the payload
      conversationGoal: null,
      sourceCampaign: "respondio_tiktok",
      flowKey: null,
      isEcho: false,
    },
  };
}

/* ---------------------------------------------------------------- client */

export interface SendResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

/**
 * Minimal Developer API client. Only what the transport needs: send a text
 * message to a contact, and list channels (used to resolve the TikTok
 * channel id at boot).
 */
export class RespondIoClient {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string = RESPONDIO_BASE_URL,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
  }

  /** GET /space/channel — used to auto-discover the TikTok channel id. */
  async listChannels(): Promise<Array<{ id: number; name: string; source: string }>> {
    const res = await fetch(`${this.baseUrl}/space/channel`, { headers: this.headers() });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: Array<{ id: number; name: string; source: string }> };
    return body.items ?? [];
  }

  async findTikTokChannelId(): Promise<number | null> {
    const channels = await this.listChannels();
    const match = channels.find((c) => TIKTOK_SOURCES.has((c.source ?? "").toLowerCase()));
    return match?.id ?? null;
  }

  /**
   * POST /contact/id:<contactId>/message
   * Retries transient failures (429 and 5xx) with exponential backoff so a
   * blip on respond.io's side never silently drops Wesley's reply.
   */
  async sendText(
    contactId: string,
    text: string,
    opts: { channelId?: number | null; attempts?: number } = {},
  ): Promise<SendResult> {
    const attempts = opts.attempts ?? 3;
    const payload: Record<string, unknown> = {
      message: { type: "text", text },
    };
    if (opts.channelId) payload.channelId = opts.channelId;

    let last: SendResult = { ok: false, detail: "not_attempted" };
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(
          `${this.baseUrl}/contact/id:${encodeURIComponent(contactId)}/message`,
          { method: "POST", headers: this.headers(), body: JSON.stringify(payload) },
        );
        if (res.ok) return { ok: true, status: res.status };

        const detail = (await res.text().catch(() => "")).slice(0, 300);
        last = { ok: false, status: res.status, detail };
        const transient = res.status === 429 || res.status >= 500;
        if (!transient) return last; // 4xx: retrying will not help
      } catch (err) {
        last = { ok: false, detail: err instanceof Error ? err.message : "network_error" };
      }
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
    return last;
  }
}
