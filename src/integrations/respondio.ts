import { createHmac, timingSafeEqual } from "node:crypto";
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

/**
 * Verifies respond.io's `X-Webhook-Signature`, which is
 * base64(HMAC-SHA256(signingKey, body)).
 *
 * respond.io's own samples disagree on whether the body is the raw bytes or
 * a re-stringified JSON, so both are accepted. Comparison is
 * constant-time to avoid leaking the key through timing.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  signingKey: string,
): boolean {
  if (!signature) return false;
  const candidates = [rawBody];
  try {
    candidates.push(JSON.stringify(JSON.parse(rawBody)));
  } catch {
    /* body is not JSON; the raw form is the only candidate */
  }
  const provided = Buffer.from(signature, "base64");
  for (const candidate of candidates) {
    const expected = createHmac("sha256", signingKey).update(candidate, "utf8").digest();
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return true;
  }
  return false;
}

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
export interface ChannelFilter {
  /** Known TikTok channel ids. Empty/null means rely on `source` alone. */
  tiktokChannelIds?: number[] | null;
}

/** Cheap look at just the channel fields, before full normalization. */
export function peekChannel(body: unknown): { id: number | null; source: string | null } {
  const raw = obj(body);
  const channel = obj(pick(raw, "channel"));
  const message = obj(pick(raw, "message"));
  const id =
    Number(str(pick(channel, "id", "channelId")) ?? str(pick(message, "channelId", "channel_id"))) ||
    null;
  const source = str(pick(channel, "source", "type", "channelSource"))?.toLowerCase() ?? null;
  return { id, source };
}

export function isTikTokSource(source: string | null): boolean {
  return !!source && TIKTOK_SOURCES.has(source);
}

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
  opts: ChannelFilter = {},
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

  /* -------- channel filter: Wesley's TikTok inbox only.
   *
   * The channel `source` is authoritative when present, so several TikTok
   * channels on the same space all work. The id list is the fallback for
   * payloads that omit the source. */
  const channelId =
    Number(str(pick(channel, "id", "channelId")) ?? str(pick(message, "channelId", "channel_id"))) ||
    null;
  const channelSource = str(pick(channel, "source", "type", "channelSource"))?.toLowerCase() ?? null;
  const allowedIds = opts.tiktokChannelIds ?? null;

  if (channelSource) {
    if (!TIKTOK_SOURCES.has(channelSource)) {
      return { kind: "ignore", reason: `other_channel_source:${channelSource}` };
    }
  } else if (allowedIds && allowedIds.length) {
    if (channelId === null || !allowedIds.includes(channelId)) {
      return { kind: "ignore", reason: `other_channel_id:${channelId ?? "none"}` };
    }
  } else {
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
  // sender.source is respond.io's own origin marker:
  // contact | user | api | ai_agent | workflow | broadcast | echo
  const senderSource = str(pick(obj(pick(raw, "sender")), "source", "type"))?.toLowerCase() ?? null;
  const senderIsUs = !!senderSource && senderSource !== "contact";
  const isOutbound =
    isEchoFlag ||
    senderIsUs ||
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
 * Caches which channel ids are TikTok, refreshing on demand. Wesley can
 * connect another TikTok channel in respond.io and it starts working
 * without a redeploy, while non-TikTok channels stay filtered out.
 */
export class TikTokChannelResolver {
  private ids: number[];
  private lastRefresh = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly client: Pick<RespondIoClient, "findTikTokChannelIds">,
    initial: number[] = [],
    private readonly minRefreshMs = 60_000,
  ) {
    this.ids = initial;
  }

  current(): number[] {
    return [...this.ids];
  }

  async refresh(force = false): Promise<number[]> {
    const stale = Date.now() - this.lastRefresh > this.minRefreshMs;
    if (!force && !stale) return this.current();
    if (!this.inFlight) {
      this.inFlight = (async () => {
        try {
          const ids = await this.client.findTikTokChannelIds();
          if (ids.length) this.ids = ids;
          this.lastRefresh = Date.now();
        } catch {
          this.lastRefresh = Date.now(); // do not hammer a failing API
        } finally {
          this.inFlight = null;
        }
      })();
    }
    await this.inFlight;
    return this.current();
  }

  /**
   * Resolves whether a payload's channel is TikTok. `source` short-circuits;
   * an unknown id triggers one refresh in case a channel was just added.
   */
  async isTikTok(channelId: number | null, source: string | null): Promise<boolean> {
    if (source) return isTikTokSource(source);
    if (channelId === null) return false;
    if (this.ids.includes(channelId)) return true;
    await this.refresh();
    return this.ids.includes(channelId);
  }
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

  /**
   * GET /contact/id:<id>/message/list — recent messages, newest first.
   * Used to recover a manual opener Wesley sent before the webhook existed.
   */
  async listMessages(
    contactId: string,
    limit = 20,
  ): Promise<Array<{ text: string | null; traffic: string | null; messageId: string | null }>> {
    try {
      const res = await fetch(
        `${this.baseUrl}/contact/id:${encodeURIComponent(contactId)}/message/list?limit=${limit}`,
        { headers: this.headers() },
      );
      if (!res.ok) return [];
      const body = (await res.json()) as { items?: unknown[] };
      return (body.items ?? []).map((item) => {
        const m = obj(item) ?? {};
        const inner = obj(pick(m, "message")) ?? m;
        return {
          text: str(pick(inner, "text", "body")),
          traffic: str(pick(m, "traffic", "direction"))?.toLowerCase() ?? null,
          messageId: str(pick(m, "messageId", "message_id", "id")),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * The most recent message Wesley sent to this contact, if any. This is the
   * fallback path for recovering his manual opener when the outbound webhook
   * was never delivered (for example the DM predates the integration).
   */
  async findLastOutboundText(contactId: string): Promise<string | null> {
    const items = await this.listMessages(contactId, 20);
    for (const item of items) {
      if (!item.text) continue;
      if (item.traffic === "outgoing" || item.traffic === "outbound") return item.text;
    }
    return null;
  }

  /** GET /space/channel — used to auto-discover the TikTok channel id. */
  async listChannels(): Promise<Array<{ id: number; name: string; source: string }>> {
    const res = await fetch(`${this.baseUrl}/space/channel`, { headers: this.headers() });
    if (!res.ok) return [];
    const body = (await res.json()) as { items?: Array<{ id: number; name: string; source: string }> };
    return body.items ?? [];
  }

  /** Every TikTok channel on the space, not just the first. */
  async findTikTokChannelIds(): Promise<number[]> {
    const channels = await this.listChannels();
    return channels
      .filter((c) => TIKTOK_SOURCES.has((c.source ?? "").toLowerCase()))
      .map((c) => c.id);
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
        // 449 is respond.io's "message currently in queue" and is retryable.
        const transient = res.status === 429 || res.status === 449 || res.status >= 500;
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
