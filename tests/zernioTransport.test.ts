/**
 * Zernio transport unit tests: the signature verifier, the payload parser and
 * the outbound sender, driven directly.
 *
 * The REFUSALS matter more than the happy path here. A bad signature that
 * passes, or an outgoing echo treated as inbound, is worse than having no
 * integration at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  accountMatches,
  describeError,
  fetchManualOpener,
  isZernioDmConfigured,
  parseZernioInboundMessage,
  sendZernioReply,
  verifyZernioSignature,
  zernioAccounts,
  zernioWebhookSecretConfigured,
} from "../src/integrations/zernio/dm.js";

const SECRET = "test-secret-do-not-use-in-production";
const KEY = "zrk_test_not_a_real_key";
const ACCOUNT = "acct_wesley";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

export function inboundBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: over.eventId ?? "evt_1",
    event: over.event ?? "message.received",
    message: {
      id: "msg_1",
      conversationId: over.conversationId ?? "conv_1",
      platform: over.platform ?? "tiktok",
      platformMessageId: "platform" in over && over.platform === null ? null : (over.platformMessageId ?? "ptf_1"),
      direction: over.direction ?? "incoming",
      text: "text" in over ? over.text : "hey saw your video about first time buyers",
      attachments: [],
      sender: "sender" in over ? over.sender : { id: "tt_user_123", name: "Jane B", username: "janeb" },
      sentAt: "2026-09-14T10:30:00.000Z",
    },
    conversation: {
      id: over.conversationId ?? "conv_1",
      participantId: "participantId" in over ? over.participantId : "tt_user_123",
      participantName: "Jane B",
      participantUsername: "janeb",
    },
    account: {
      id: over.accountId ?? ACCOUNT,
      accountId: over.accountId ?? ACCOUNT,
      platform: over.platform ?? "tiktok",
      username: "wesley.realtor",
    },
    timestamp: "2026-09-14T10:30:00.000Z",
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  process.env.ZERNIO_DM_API_KEY = KEY;
  process.env.ZERNIO_TIKTOK_ACCOUNT_ID = ACCOUNT;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ZERNIO_WEBHOOK_SECRET;
  delete process.env.ZERNIO_DM_API_KEY;
  delete process.env.ZERNIO_TIKTOK_ACCOUNT_ID;
});

function httpOk(json: unknown, status = 200): Response {
  return { ok: status < 400, status, text: async () => JSON.stringify(json) } as unknown as Response;
}
function httpErr(body: string, status: number): Response {
  return { ok: false, status, text: async () => body } as unknown as Response;
}

describe("Zernio signature verification", () => {
  it("1. accepts a correct signature over the exact raw body", () => {
    const body = inboundBody();
    expect(verifyZernioSignature(body, sign(body))).toBe(true);
  });

  it("2. rejects a signature computed over a different body", () => {
    const body = inboundBody();
    expect(verifyZernioSignature(`${body} `, sign(body))).toBe(false);
  });

  it("3. rejects a missing or empty signature", () => {
    const body = inboundBody();
    expect(verifyZernioSignature(body, null)).toBe(false);
    expect(verifyZernioSignature(body, "")).toBe(false);
    expect(verifyZernioSignature(body, "   ")).toBe(false);
  });

  it("4. rejects a signature made with the wrong secret", () => {
    const body = inboundBody();
    expect(verifyZernioSignature(body, sign(body, "some-other-secret"))).toBe(false);
  });

  it("5. rejects a truncated signature without throwing on length mismatch", () => {
    const body = inboundBody();
    expect(verifyZernioSignature(body, sign(body).slice(0, 32))).toBe(false);
  });

  it("6. accepts uppercase hex, since the comparison normalizes case", () => {
    const body = inboundBody();
    expect(verifyZernioSignature(body, sign(body).toUpperCase())).toBe(true);
  });

  it("7. an unset secret rejects everything rather than opening the door", () => {
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    const body = inboundBody();
    expect(zernioWebhookSecretConfigured()).toBe(false);
    expect(verifyZernioSignature(body, sign(body))).toBe(false);
  });
});

describe("Zernio payload parsing", () => {
  it("8. parses a real inbound message into the fields the pipeline needs", () => {
    const r = parseZernioInboundMessage(JSON.parse(inboundBody()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.senderId).toBe("tt_user_123");
    expect(r.event.conversationId).toBe("conv_1");
    expect(r.event.accountId).toBe(ACCOUNT);
    expect(r.event.platform).toBe("tiktok");
    expect(r.event.senderUsername).toBe("janeb");
    expect(r.event.senderName).toBe("Jane B");
    expect(r.event.eventId).toBe("evt_1");
  });

  it("9. refuses our own outgoing echo, so the agent never answers itself", () => {
    const r = parseZernioInboundMessage(JSON.parse(inboundBody({ direction: "outgoing" })));
    expect(r).toEqual({ ok: false, reason: "outgoing_echo" });
  });

  it("10. refuses any event other than message.received", () => {
    const r = parseZernioInboundMessage(JSON.parse(inboundBody({ event: "post.published" })));
    expect(r).toEqual({ ok: false, reason: "unsupported_event" });
  });

  it("11. refuses a non-TikTok platform", () => {
    const r = parseZernioInboundMessage(JSON.parse(inboundBody({ platform: "instagram" })));
    expect(r).toEqual({ ok: false, reason: "unsupported_platform" });
  });

  it("12. refuses a missing sender id, which would merge every such lead into one thread", () => {
    const r = parseZernioInboundMessage(
      JSON.parse(inboundBody({ sender: { name: "No Id" }, participantId: undefined })),
    );
    expect(r).toEqual({ ok: false, reason: "missing_identity" });
  });

  it("13. refuses garbage bodies", () => {
    expect(parseZernioInboundMessage(null).ok).toBe(false);
    expect(parseZernioInboundMessage("a string").ok).toBe(false);
    expect(parseZernioInboundMessage([1, 2, 3]).ok).toBe(false);
    expect(parseZernioInboundMessage({ nope: true })).toEqual({ ok: false, reason: "unsupported_event" });
  });

  it("14. keeps an attachment-only message as an empty-text turn rather than dropping it", () => {
    const r = parseZernioInboundMessage(JSON.parse(inboundBody({ text: null })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.text).toBe("");
  });

  it("15. falls back to the conversation participant when the sender block is thin", () => {
    const r = parseZernioInboundMessage(JSON.parse(inboundBody({ sender: {} })));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.event.senderId).toBe("tt_user_123");
  });
});

describe("account isolation", () => {
  it("16. accepts only the configured TikTok account", () => {
    expect(accountMatches(ACCOUNT)).toBe(true);
    expect(accountMatches("acct_marco")).toBe(false);
  });

  it("17. matches nothing at all when no account id is configured", () => {
    delete process.env.ZERNIO_TIKTOK_ACCOUNT_ID;
    expect(accountMatches(ACCOUNT)).toBe(false);
    expect(accountMatches("")).toBe(false);
  });
});

describe("manual opener recovery", () => {
  it("18. returns the latest outgoing text sent before the inbound message", async () => {
    fetchMock.mockResolvedValue(
      httpOk({
        messages: [
          { id: "a", direction: "outgoing", text: "Hey! Saw you watched the first time buyer video" },
          { id: "b", direction: "incoming", text: "yeah" },
          { id: "c", direction: "outgoing", text: "Happy to help, buying or selling?" },
          { id: "ptf_1", direction: "incoming", text: "buying" },
          { id: "d", direction: "outgoing", text: "this one came after and must not be used" },
        ],
      }),
    );
    const opener = await fetchManualOpener({
      conversationId: "conv_1",
      accountId: ACCOUNT,
      beforeMessageId: "ptf_1",
    });
    expect(opener).toBe("Happy to help, buying or selling?");
  });

  it("19. skips an image-only outbound instead of seeding a blank opener", async () => {
    fetchMock.mockResolvedValue(
      httpOk({
        messages: [
          { id: "a", direction: "outgoing", text: "Hey, saw your comment" },
          { id: "b", direction: "outgoing", text: null },
        ],
      }),
    );
    expect(await fetchManualOpener({ conversationId: "conv_1", accountId: ACCOUNT })).toBe(
      "Hey, saw your comment",
    );
  });

  it("20. returns null rather than throwing when Zernio fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      fetchManualOpener({ conversationId: "conv_1", accountId: ACCOUNT }),
    ).resolves.toBeNull();
    fetchMock.mockResolvedValue(httpErr("nope", 500));
    await expect(
      fetchManualOpener({ conversationId: "conv_1", accountId: ACCOUNT }),
    ).resolves.toBeNull();
  });

  it("21. returns null when the thread has no outgoing message at all", async () => {
    fetchMock.mockResolvedValue(httpOk({ messages: [{ id: "a", direction: "incoming", text: "hi" }] }));
    expect(await fetchManualOpener({ conversationId: "conv_1", accountId: ACCOUNT })).toBeNull();
  });
});

describe("outbound send", () => {
  it("22. posts to the conversation with the account id, message and idempotency key", async () => {
    fetchMock.mockResolvedValue(httpOk({ message: { id: "sent_1" } }, 201));
    const r = await sendZernioReply({
      conversationId: "conv 1/with slash",
      accountId: ACCOUNT,
      text: "  What is the best number to text you at?  ",
      idempotencyKey: "zernio:evt_1",
    });
    expect(r.success).toBe(true);
    expect(r.messageId).toBe("sent_1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://zernio.com/api/v1/inbox/conversations/conv%201%2Fwith%20slash/messages");
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toBe("zernio:evt_1");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body)).toEqual({
      accountId: ACCOUNT,
      message: "What is the best number to text you at?",
    });
  });

  it("23. sends nothing for an empty reply", async () => {
    const r = await sendZernioReply({ conversationId: "conv_1", accountId: ACCOUNT, text: "   " });
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("24. names a closed TikTok messaging window distinctly from an AI failure", async () => {
    fetchMock.mockResolvedValue(
      httpErr(JSON.stringify({ error: "Cannot send: the 48 hour messaging window has closed" }), 422),
    );
    const r = await sendZernioReply({ conversationId: "conv_1", accountId: ACCOUNT, text: "hi" });
    expect(r.success).toBe(false);
    expect(r.windowClosed).toBe(true);
    expect(r.status).toBe(422);
  });

  it("25. reports an ordinary transport failure without marking the window closed", async () => {
    fetchMock.mockResolvedValue(httpErr("upstream exploded", 502));
    const r = await sendZernioReply({ conversationId: "conv_1", accountId: ACCOUNT, text: "hi" });
    expect(r.success).toBe(false);
    expect(r.windowClosed).toBe(false);
    expect(r.error).toContain("upstream exploded");
  });

  it("26. never puts the API key or webhook secret into an error string", async () => {
    fetchMock.mockResolvedValue(
      httpErr(`rejected request with Authorization: Bearer ${KEY} and secret ${SECRET}`, 401),
    );
    const r = await sendZernioReply({ conversationId: "conv_1", accountId: ACCOUNT, text: "hi" });
    expect(r.error).not.toContain(KEY);
    expect(r.error).not.toContain(SECRET);
    expect(r.error).toContain("[redacted]");
    expect(describeError(`key=${KEY}`, 400)).not.toContain(KEY);
  });

  it("27. refuses to send when no API key is configured", async () => {
    delete process.env.ZERNIO_DM_API_KEY;
    expect(isZernioDmConfigured()).toBe(false);
    const r = await sendZernioReply({ conversationId: "conv_1", accountId: ACCOUNT, text: "hi" });
    expect(r.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("connected accounts", () => {
  it("28. lists accounts and flags one needing reconnection as inactive", async () => {
    fetchMock.mockResolvedValue(
      httpOk({
        accounts: [
          { _id: ACCOUNT, platform: "tiktok", username: "wesley.realtor", isActive: true },
          { _id: "acct_x", platform: "tiktok", username: "stale", needsReconnection: true },
        ],
      }),
    );
    const r = await zernioAccounts();
    expect(r.ok).toBe(true);
    expect(r.accounts).toHaveLength(2);
    expect(r.accounts[0]!.active).toBe(true);
    expect(r.accounts[1]!.active).toBe(false);
  });

  it("29. surfaces an auth failure without leaking the key", async () => {
    fetchMock.mockResolvedValue(httpErr(`invalid key ${KEY}`, 401));
    const r = await zernioAccounts();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.error).not.toContain(KEY);
  });
});
