/**
 * Zernio DM transport for TikTok.
 *
 * Wesley's AI pipeline is unchanged by this file. Everything here is transport:
 * receiving a TikTok DM, proving it really came from Zernio, and delivering the
 * pipeline's reply back to the same conversation.
 *
 * THE ONE ARCHITECTURAL FACT THAT SHAPES EVERYTHING. ManyChat called us and
 * sent whatever we returned in the HTTP response body. Zernio inverts that:
 *
 *   ManyChat:  POST /webhook/tiktok      -> { reply }   -> ManyChat sends it
 *   Zernio:    POST /api/zernio/webhook  -> 200 (fast)  -> WE call Zernio to send
 *
 * Two consequences, both load bearing:
 *
 *   1. Zernio needs a 2xx within five seconds or it retries with backoff. A
 *      retried inbound is a duplicate DM, which is the failure this codebase
 *      spends the most code preventing. So the route acks first and runs the
 *      pipeline afterwards. See src/app/zernioWebhook.ts.
 *   2. The reply is a second HTTP request of our own, so it can fail on its own
 *      after the pipeline has already written the assistant message. Every send
 *      carries an Idempotency-Key derived from the inbound event, so a retry
 *      after an ambiguous failure replays rather than double sends.
 *
 * TIKTOK'S OWN RULES, inherited and not negotiable:
 *   - Reply only. A business cannot start a conversation. This already matches
 *     how Wesley runs the channel: a VA opens the thread by hand in the app and
 *     the agent takes over on the lead's reply. fetchManualOpener() below reads
 *     that opener back so the stored thread matches what the lead sees.
 *   - 10 messages within 48 hours of the lead's last message. A send outside
 *     that window fails with TikTok's own error, which we surface as
 *     `windowClosed` rather than letting it read as an AI failure.
 *   - Text or one image, never both.
 *
 * ACCOUNT ISOLATION. This Zernio profile may have more than one connected
 * account on it. Every inbound event is checked against ZERNIO_TIKTOK_ACCOUNT_ID
 * before anything is processed, so another account's traffic can never create a
 * Wesley lead or earn a Wesley reply. See accountMatches() and the route.
 *
 * CREDENTIALS NEVER LEAVE THIS MODULE. The key is read from the environment at
 * call time, attached as a Bearer header, and never returned, logged, or placed
 * in an error string. describeError() exists so callers have something safe to
 * log.
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

const ZERNIO_API_BASE = process.env.ZERNIO_API_BASE?.trim() || "https://zernio.com/api/v1";

/** Zernio's documented budget for our webhook ack. We stay well inside it. */
export const ZERNIO_ACK_BUDGET_MS = 5000;

function apiKey(): string {
  return process.env.ZERNIO_DM_API_KEY?.trim() ?? "";
}

function webhookSecret(): string {
  return process.env.ZERNIO_WEBHOOK_SECRET?.trim() ?? "";
}

/** The Zernio account id for Wesley's TikTok. Required on every send and read. */
export function zernioTikTokAccountId(): string {
  return process.env.ZERNIO_TIKTOK_ACCOUNT_ID?.trim() ?? "";
}

export function isZernioDmConfigured(): boolean {
  return Boolean(apiKey());
}

export function zernioWebhookSecretConfigured(): boolean {
  return Boolean(webhookSecret());
}

export function zernioAccountIdConfigured(): boolean {
  return Boolean(zernioTikTokAccountId());
}

/**
 * Account isolation, the check that keeps two agents on one Zernio profile from
 * ever touching each other's conversations.
 *
 * Fails CLOSED when ZERNIO_TIKTOK_ACCOUNT_ID is unset: an unconfigured server
 * accepts no account at all. Dropping a message is recoverable; answering
 * someone else's lead in Wesley's voice is not.
 */
export function accountMatches(eventAccountId: string): boolean {
  const configured = zernioTikTokAccountId();
  if (!configured) return false;
  return eventAccountId.trim() === configured;
}

/**
 * Verify `X-Zernio-Signature`: lowercase hex HMAC-SHA256 of the RAW request
 * body, keyed by the secret we chose and registered with Zernio.
 *
 * Must be given the raw bytes, not a re-serialized object. JSON.stringify of a
 * parsed body is not byte identical to what was signed (key order, unicode
 * escaping, whitespace), so re-serializing would reject every legitimate
 * delivery. That is why the route reads the body as a Buffer and parses after.
 */
export function verifyZernioSignature(rawBody: Buffer | string, signature: string | null | undefined): boolean {
  const secret = webhookSecret();
  if (!secret) return false;
  const provided = typeof signature === "string" ? signature.trim().toLowerCase() : "";
  if (!provided) return false;

  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  /* timingSafeEqual throws on a length mismatch, and the throw itself would
     leak the expected length through the error path, so compare lengths up
     front and only then compare in constant time. */
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The subset of Zernio's `message.received` payload this integration reads. */
export interface ZernioInboundMessage {
  /** Stable webhook event id. The dedupe handle and the idempotency key root. */
  eventId: string;
  conversationId: string;
  accountId: string;
  platform: string;
  /** The sender's platform identifier. This becomes the lead key. */
  senderId: string;
  senderName: string | null;
  senderUsername: string | null;
  text: string;
  platformMessageId: string | null;
}

export type ZernioRejectReason =
  | "not_an_object"
  | "unsupported_event"
  | "outgoing_echo"
  | "unsupported_platform"
  | "missing_identity";

export type ZernioParseResult =
  | { ok: true; event: ZernioInboundMessage }
  | { ok: false; reason: ZernioRejectReason };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Normalize a `message.received` body, or say why this is not something to act
 * on. The reason is returned rather than swallowed so the route can log which
 * refusal fired without logging the payload.
 *
 * Refuses, deliberately:
 *   - any event other than `message.received`
 *   - `direction: "outgoing"`, which is our OWN send echoing back. Acting on
 *     one would have the agent answer itself in a loop.
 *   - anything that is not TikTok. Wesley's agent is a TikTok agent and its
 *     prompts assume TikTok's rules.
 *   - a missing sender id, which would otherwise key every such message to the
 *     same lead. Losing one message is recoverable; a merged thread is not.
 */
export function parseZernioInboundMessage(body: unknown): ZernioParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "not_an_object" };
  }
  const b = body as Record<string, unknown>;
  if (str(b.event) !== "message.received") return { ok: false, reason: "unsupported_event" };

  const message = (b.message ?? {}) as Record<string, unknown>;
  const conversation = (b.conversation ?? {}) as Record<string, unknown>;
  const account = (b.account ?? {}) as Record<string, unknown>;
  const sender = (message.sender ?? {}) as Record<string, unknown>;

  if (str(message.direction) === "outgoing") return { ok: false, reason: "outgoing_echo" };

  const platform = (str(message.platform) ?? str(account.platform) ?? "").toLowerCase();
  if (platform !== "tiktok") return { ok: false, reason: "unsupported_platform" };

  const senderId = str(sender.id) ?? str(conversation.participantId);
  const conversationId = str(message.conversationId) ?? str(conversation.id);
  const accountId = str(account.accountId) ?? str(account.id);
  if (!senderId || !conversationId || !accountId) return { ok: false, reason: "missing_identity" };

  return {
    ok: true,
    event: {
      eventId: str(b.id) ?? `${conversationId}:${str(message.id) ?? randomUUID()}`,
      conversationId,
      accountId,
      platform: "tiktok",
      senderId,
      senderName: str(sender.name) ?? str(conversation.participantName),
      senderUsername: str(sender.username) ?? str(conversation.participantUsername),
      /* Attachment-only messages arrive with a null text. Kept as "" rather
         than dropped so the turn still reaches the pipeline, which already
         treats an empty message as "nothing to answer" instead of inventing
         something. */
      text: str(message.text) ?? "",
      platformMessageId: str(message.platformMessageId) ?? str(message.id),
    },
  };
}

interface ZernioResponse {
  ok: boolean;
  status: number;
  json: unknown;
  text: string;
}

async function zernioFetch(
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<ZernioResponse> {
  const res = await fetch(`${ZERNIO_API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Non-JSON error bodies exist. The raw text is kept for describeError. */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * A short error description that is safe to put in a log line.
 *
 * Bounded, and scrubbed of anything that looks like a bearer token, a Zernio
 * key or our webhook secret, because a provider error body can echo back the
 * request it rejected.
 */
export function describeError(raw: string, status: number): string {
  const secrets = [apiKey(), webhookSecret()].filter((s) => s.length >= 8);
  let out = raw.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]");
  for (const s of secrets) out = out.split(s).join("[redacted]");
  out = out.replace(/\b(zrk|sk)_[A-Za-z0-9._\-]{6,}/g, "[redacted]");
  out = out.replace(/\s+/g, " ").trim();
  return out.slice(0, 300) || `HTTP ${status}`;
}

/**
 * The VA's manually sent opener, so the thread Wesley's pipeline sees matches
 * what the lead actually sees.
 *
 * Wesley's TikTok flow is: a VA DMs someone by hand in the app, and the agent
 * takes over when they reply. ManyChat passed that opener as a field on the
 * webhook; Zernio has no such field, so we read it back off the conversation.
 * Same value, different source. seedManualOpener() in the pipeline then behaves
 * exactly as it does today, which is the whole point: this is a transport swap,
 * not a funnel change.
 *
 * WHAT COUNTS AS THE OPENER. The latest outgoing text message sent BEFORE the
 * inbound one, not simply the first outgoing message in the thread. On a fresh
 * thread those are the same. On a thread the agent has already answered they
 * are not, and picking the earliest would hand the model a stale line while
 * picking an agent reply would teach it to treat its own output as a human
 * opener. Neither happens in practice because seedManualOpener() refuses to
 * seed once any assistant message exists, but this function must not depend on
 * that to be correct.
 *
 * Returns null on any failure. A missing opener costs the model one piece of
 * context; a thrown error here would cost the lead their reply, so this never
 * throws.
 */
export async function fetchManualOpener(input: {
  conversationId: string;
  accountId: string;
  /** Provider id of the inbound message, so we only look at what came before. */
  beforeMessageId?: string | null;
}): Promise<string | null> {
  if (!isZernioDmConfigured()) return null;
  try {
    const qs = new URLSearchParams({
      accountId: input.accountId,
      sortOrder: "asc",
      limit: "20",
    });
    const r = await zernioFetch(
      `/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages?${qs}`,
      { method: "GET" },
    );
    if (!r.ok) return null;

    const payload = r.json as { messages?: unknown; data?: unknown } | null;
    const list = (
      Array.isArray(payload?.messages) ? payload.messages : Array.isArray(payload?.data) ? payload.data : []
    ) as Record<string, unknown>[];

    /* Cut the list at the inbound message when we can identify it, so an
       outgoing message that landed after it is never mistaken for the opener.
       Zernio's ordering is requested ascending; if the id is absent we fall
       back to the whole list, which on a fresh thread is the same thing. */
    const cutAt = input.beforeMessageId
      ? list.findIndex((m) => str(m.id) === input.beforeMessageId || str(m.platformMessageId) === input.beforeMessageId)
      : -1;
    const earlier = cutAt >= 0 ? list.slice(0, cutAt) : list;

    /* Latest outgoing message that actually carries text. An image-only or
       empty outbound is skipped rather than seeding a blank opener. */
    for (let i = earlier.length - 1; i >= 0; i--) {
      const m = earlier[i]!;
      if (str(m.direction) !== "outgoing") continue;
      const text = str(m.text);
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ZernioSendResult {
  success: boolean;
  status: number;
  messageId?: string;
  /** Safe to log: bounded and scrubbed of credentials. */
  error?: string;
  /**
   * True when TikTok refused because its 48 hour / 10 message reply window has
   * closed. Distinct from an AI failure and from a Zernio outage, because the
   * operator response is different: nothing is broken, the lead simply went
   * quiet for too long and a human has to reopen the thread.
   */
  windowClosed?: boolean;
}

const WINDOW_CLOSED = /messag\w*\s*window|outside.{0,20}window|48\s*hour|too many messages|message limit|cannot (?:send|initiate)|not allowed to (?:send|message)/i;

/**
 * Send the agent's reply back to the lead.
 *
 * `idempotencyKey` is derived from the inbound event, so a retry of the same
 * inbound can never produce a second outbound: Zernio replays the original
 * response for a repeated key with an identical body rather than sending again.
 */
export async function sendZernioReply(input: {
  conversationId: string;
  accountId: string;
  text: string;
  idempotencyKey?: string;
}): Promise<ZernioSendResult> {
  if (!isZernioDmConfigured()) {
    return { success: false, status: 0, error: "ZERNIO_DM_API_KEY is not set" };
  }
  const text = input.text?.trim();
  if (!text) return { success: false, status: 0, error: "empty reply, nothing sent" };

  try {
    const r = await zernioFetch(
      `/inbox/conversations/${encodeURIComponent(input.conversationId)}/messages`,
      {
        method: "POST",
        headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {},
        body: JSON.stringify({ accountId: input.accountId, message: text }),
      },
    );
    if (!r.ok) {
      const error = describeError(r.text, r.status);
      return {
        success: false,
        status: r.status,
        error,
        windowClosed: WINDOW_CLOSED.test(error),
      };
    }
    const sent = (r.json ?? {}) as { message?: { id?: unknown }; id?: unknown };
    return {
      success: true,
      status: r.status,
      messageId: str(sent.message?.id) ?? str(sent.id) ?? undefined,
    };
  } catch (err) {
    /* A transport throw carries no provider text, but the message can still
       contain the URL, so it goes through the same scrubber. */
    return {
      success: false,
      status: 0,
      error: describeError(err instanceof Error ? err.message : String(err), 0),
    };
  }
}

export interface ZernioAccount {
  id: string;
  platform: string;
  username: string | null;
  active: boolean;
}

/** Connected accounts. Used by /api/zernio/status to prove the key works. */
export async function zernioAccounts(): Promise<{
  ok: boolean;
  status: number;
  accounts: ZernioAccount[];
  error?: string;
}> {
  if (!isZernioDmConfigured()) {
    return { ok: false, status: 0, accounts: [], error: "ZERNIO_DM_API_KEY is not set" };
  }
  try {
    const r = await zernioFetch("/accounts", { method: "GET" });
    if (!r.ok) {
      return { ok: false, status: r.status, accounts: [], error: describeError(r.text, r.status) };
    }
    const payload = r.json as { accounts?: unknown; data?: unknown } | null;
    const list = (
      Array.isArray(payload?.accounts) ? payload.accounts : Array.isArray(payload?.data) ? payload.data : []
    ) as Record<string, unknown>[];
    return {
      ok: true,
      status: r.status,
      accounts: list.map((a) => ({
        id: String(a._id ?? a.id ?? a.accountId ?? ""),
        platform: String(a.platform ?? ""),
        username: str(a.username),
        active: a.isActive !== false && a.needsReconnection !== true,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      accounts: [],
      error: describeError(err instanceof Error ? err.message : String(err), 0),
    };
  }
}
