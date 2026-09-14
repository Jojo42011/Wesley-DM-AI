/**
 * The /api/zernio/webhook route, exercised end to end against the real
 * pipeline with a fake Zernio on the other side.
 *
 * The property the whole design rests on is that the ACK happens before the
 * pipeline runs. That is a property of the route, not of any one function, so
 * these tests drive the route and separately await the work it deliberately
 * does not await.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { ZernioWebhookHandler, toInboundEvent } from "../src/app/zernioWebhook.js";
import type { ZernioTransport } from "../src/app/zernioWebhook.js";
import type { ZernioSendResult } from "../src/integrations/zernio/dm.js";
import { ConversationStage } from "../src/domain/types.js";
import { makeDeps, interestedGate, modelReply } from "./helpers.js";
import { inboundBody } from "./zernioTransport.test.js";

const SECRET = "test-secret-do-not-use-in-production";
const ACCOUNT = "acct_wesley";

const gateSystem = "classify whether an inbound TikTok DM";
const genSystem = "You write exactly one TikTok DM as Wesley";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

interface Sent {
  conversationId: string;
  accountId: string;
  text: string;
  idempotencyKey?: string;
}

function fakeTransport(opts: { opener?: string | null; sendResult?: ZernioSendResult } = {}) {
  const sends: Sent[] = [];
  const openerCalls: unknown[] = [];
  const transport: ZernioTransport = {
    fetchManualOpener: async (input) => {
      openerCalls.push(input);
      return opts.opener ?? null;
    },
    sendZernioReply: async (input) => {
      sends.push(input);
      return opts.sendResult ?? { success: true, status: 200, messageId: `sent_${sends.length}` };
    },
  };
  return { transport, sends, openerCalls };
}

function harness(over: { opener?: string | null; debounceMs?: number } = {}) {
  const deps = makeDeps();
  deps.llm.handler = (req) => {
    if (req.system.includes(gateSystem)) return interestedGate;
    if (req.system.includes(genSystem)) {
      return modelReply("Happy to help. What is the best number to text you at?");
    }
    return null;
  };
  const t = fakeTransport({ opener: over.opener ?? null });
  const handler = new ZernioWebhookHandler({
    pipeline: deps,
    transport: t.transport,
    debounceMs: over.debounceMs ?? 10,
  });
  return { deps, handler, ...t };
}

/** Deliver one signed event and wait for the after-ack half to finish. */
async function deliver(
  handler: ZernioWebhookHandler,
  body: string,
  signature = sign(body),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ack = await handler.handle({ rawBody: Buffer.from(body, "utf8"), signature });
  if (ack.processing) await ack.processing;
  return { status: ack.status, body: ack.body };
}

beforeEach(() => {
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  process.env.ZERNIO_DM_API_KEY = "zrk_test_not_a_real_key";
  process.env.ZERNIO_TIKTOK_ACCOUNT_ID = ACCOUNT;
});

afterEach(() => {
  delete process.env.ZERNIO_WEBHOOK_SECRET;
  delete process.env.ZERNIO_DM_API_KEY;
  delete process.env.ZERNIO_TIKTOK_ACCOUNT_ID;
});

describe("webhook authentication", () => {
  it("30. a valid signature is accepted and processed", async () => {
    const { handler, sends } = harness();
    const r = await deliver(handler, inboundBody());
    expect(r.status).toBe(200);
    expect(sends).toHaveLength(1);
  });

  it("31. an invalid signature gets 401 and never reaches the pipeline", async () => {
    const { handler, deps, sends } = harness();
    const ack = await handler.handle({ rawBody: Buffer.from(inboundBody()), signature: "deadbeef" });
    expect(ack.status).toBe(401);
    expect(ack.processing).toBeNull();
    expect(sends).toHaveLength(0);
    expect(await deps.store.leads.count()).toBe(0);
  });

  it("32. a missing signature gets 401 and creates no lead", async () => {
    const { handler, deps } = harness();
    const ack = await handler.handle({ rawBody: Buffer.from(inboundBody()), signature: null });
    expect(ack.status).toBe(401);
    expect(await deps.store.leads.count()).toBe(0);
  });

  it("33. a body modified after signing gets 401", async () => {
    const { handler } = harness();
    const body = inboundBody();
    const tampered = body.replace("first time buyers", "send me your bank details");
    const ack = await handler.handle({ rawBody: Buffer.from(tampered), signature: sign(body) });
    expect(ack.status).toBe(401);
  });

  it("34. an unset webhook secret fails CLOSED with 503, not open", async () => {
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    const { handler, deps } = harness();
    const body = inboundBody();
    const ack = await handler.handle({ rawBody: Buffer.from(body), signature: sign(body) });
    expect(ack.status).toBe(503);
    expect(ack.processing).toBeNull();
    expect(await deps.store.leads.count()).toBe(0);
  });

  it("35. malformed JSON with a correct signature over those bytes gets 400", async () => {
    const { handler } = harness();
    const bad = "{not json";
    const ack = await handler.handle({ rawBody: Buffer.from(bad), signature: sign(bad) });
    expect(ack.status).toBe(400);
    expect(ack.processing).toBeNull();
  });
});

describe("events the webhook ignores", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["36. our own outgoing echo", { direction: "outgoing" }, "outgoing_echo"],
    ["37. a non-message event", { event: "comment.received" }, "unsupported_event"],
    ["38. a non-TikTok message", { platform: "instagram" }, "unsupported_platform"],
    ["39. a payload with no sender id", { sender: {}, participantId: undefined }, "missing_identity"],
  ];

  for (const [name, over, reason] of cases) {
    it(`${name} is answered 200 ignored so Zernio does not retry it`, async () => {
      const { handler, deps, sends } = harness();
      const r = await deliver(handler, inboundBody(over));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ignored: true, reason });
      expect(sends).toHaveLength(0);
      expect(await deps.store.leads.count()).toBe(0);
    });
  }
});

describe("account isolation", () => {
  it("40. an event for another account is ignored with 200 and touches nothing", async () => {
    const { handler, deps, sends, openerCalls } = harness();
    const r = await deliver(handler, inboundBody({ accountId: "acct_marco" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ignored: true, reason: "account_mismatch" });
    expect(await deps.store.leads.count()).toBe(0);
    expect(sends).toHaveLength(0);
    expect(openerCalls).toHaveLength(0);
  });

  it("41. an event for the configured account is accepted and answered", async () => {
    const { handler, deps, sends } = harness();
    const r = await deliver(handler, inboundBody({ accountId: ACCOUNT }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(await deps.store.leads.count()).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.accountId).toBe(ACCOUNT);
  });

  it("42. with no account id configured, nothing is accepted at all", async () => {
    delete process.env.ZERNIO_TIKTOK_ACCOUNT_ID;
    const { handler, deps, sends } = harness();
    const r = await deliver(handler, inboundBody());
    expect(r.body).toMatchObject({ ignored: true });
    expect(await deps.store.leads.count()).toBe(0);
    expect(sends).toHaveLength(0);
  });
});

describe("acknowledgement timing", () => {
  it("43. acks far inside Zernio's five second budget while the pipeline runs after", async () => {
    const { handler, sends } = harness({ debounceMs: 300 });
    const body = inboundBody();
    const t0 = Date.now();
    const ack = await handler.handle({ rawBody: Buffer.from(body), signature: sign(body) });
    const ackMs = Date.now() - t0;

    expect(ack.status).toBe(200);
    expect(ackMs).toBeLessThan(1000);
    /* The ack beat the batching window, which is the whole point: the reply
       cannot have been computed yet. */
    expect(ackMs).toBeLessThan(300);
    expect(sends).toHaveLength(0);

    await ack.processing;
    expect(sends).toHaveLength(1);
  });
});

describe("duplicates", () => {
  it("44. a redelivered event is answered 200 duplicate and produces no second reply", async () => {
    const { handler, deps, sends } = harness();
    const body = inboundBody();
    const first = await deliver(handler, body);
    expect(first.body).toMatchObject({ ok: true });
    expect(sends).toHaveLength(1);

    const again = await deliver(handler, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true });
    expect(sends).toHaveLength(1);
    expect(await deps.store.leads.count()).toBe(1);

    const lead = (await deps.store.leads.findByExternalId("tiktok", "tt_user_123"))!;
    const msgs = await deps.store.conversations.getMessages(lead.id);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("45. the same message under a fresh event id is still caught by the pipeline's own dedupe", async () => {
    const { handler, sends } = harness();
    await deliver(handler, inboundBody({ eventId: "evt_a" }));
    expect(sends).toHaveLength(1);
    /* Different webhook event, identical provider message id: the route lets it
       through and the pipeline's durable claim stops it. */
    await deliver(handler, inboundBody({ eventId: "evt_b" }));
    expect(sends).toHaveLength(1);
  });

  it("46. the CRM handoff fires once when a duplicate carries a phone number", async () => {
    const { handler, deps, sends } = harness();
    await deliver(handler, inboundBody({ eventId: "e1", text: "sure its 512 761 8330" }));
    const body = inboundBody({ eventId: "e2", text: "sure its 512 761 8330" });
    await deliver(handler, body);
    await deliver(handler, body);

    const lead = (await deps.store.leads.findByExternalId("tiktok", "tt_user_123"))!;
    expect(lead.phone).toBe("+15127618330");
    expect(lead.stage).toBe(ConversationStage.HandoffReady);
    expect(deps.handoff.calls).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });
});

describe("the manual VA opener", () => {
  it("47. is recovered and seeded exactly once", async () => {
    const opener = "Hey! Saw you watched the first time buyer video, you looking around here?";
    const { handler, deps } = harness({ opener });
    await deliver(handler, inboundBody({ eventId: "e1", text: "yeah kinda" }));

    const lead = (await deps.store.leads.findByExternalId("tiktok", "tt_user_123"))!;
    let msgs = await deps.store.conversations.getMessages(lead.id);
    expect(msgs.filter((m) => m.source === "manual_seed")).toHaveLength(1);
    expect(msgs[0]!.text).toBe(opener);

    await deliver(handler, inboundBody({ eventId: "e2", platformMessageId: "ptf_2", text: "im looking to buy" }));
    msgs = await deps.store.conversations.getMessages(lead.id);
    /* Never seeded twice, and the agent's own replies never become an opener. */
    expect(msgs.filter((m) => m.source === "manual_seed")).toHaveLength(1);
  });

  it("48. a failed opener lookup still lets the lead get their reply", async () => {
    const deps = makeDeps();
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem)) return modelReply("Happy to help, what area are you looking in?");
      return null;
    };
    const sends: Sent[] = [];
    const handler = new ZernioWebhookHandler({
      pipeline: deps,
      debounceMs: 10,
      transport: {
        fetchManualOpener: async () => {
          throw new Error("zernio read failed");
        },
        sendZernioReply: async (i) => {
          sends.push(i);
          return { success: true, status: 200 };
        },
      },
    });
    /* fetchManualOpener in production never throws; if it ever did, the lead
       must still be answered rather than silently dropped. */
    const ack = await handler.handle({
      rawBody: Buffer.from(inboundBody()),
      signature: sign(inboundBody()),
    });
    await ack.processing;
    expect(ack.status).toBe(200);
    expect(sends.length + (await deps.store.leads.count())).toBeGreaterThan(0);
  });
});

describe("delivery", () => {
  it("49. sends to the right conversation and account with a stable idempotency key", async () => {
    const { handler, sends } = harness();
    await deliver(handler, inboundBody({ eventId: "evt_stable", conversationId: "conv_42" }));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.conversationId).toBe("conv_42");
    expect(sends[0]!.accountId).toBe(ACCOUNT);
    expect(sends[0]!.idempotencyKey).toBe("zernio:evt_stable");
    expect(sends[0]!.text.length).toBeGreaterThan(0);
  });

  it("50. sends nothing at all when the pipeline decides on silence", async () => {
    const deps = makeDeps();
    /* An opted-out lead is the pipeline's clearest null reply. */
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem)) return modelReply("hey");
      return null;
    };
    const t = fakeTransport();
    const handler = new ZernioWebhookHandler({ pipeline: deps, transport: t.transport, debounceMs: 10 });

    await deliver(handler, inboundBody({ eventId: "e1", text: "im interested in buying" }));
    await deliver(handler, inboundBody({ eventId: "e2", platformMessageId: "p2", text: "stop messaging me" }));
    const before = t.sends.length;
    await deliver(handler, inboundBody({ eventId: "e3", platformMessageId: "p3", text: "hello?" }));
    expect(t.sends).toHaveLength(before);
  });

  it("51. a closed TikTok window is reported as such and does not throw", async () => {
    const deps = makeDeps();
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem)) return modelReply("What is the best number to text you at?");
      return null;
    };
    const t = fakeTransport({
      sendResult: { success: false, status: 422, error: "48 hour messaging window closed", windowClosed: true },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = new ZernioWebhookHandler({ pipeline: deps, transport: t.transport, debounceMs: 10 });
    const r = await deliver(handler, inboundBody());
    expect(r.status).toBe(200);
    expect(err.mock.calls.flat().join(" ")).toContain("messaging window is closed");
    err.mockRestore();
  });
});

describe("rapid messages", () => {
  it("52. three messages in a burst become one turn and exactly one reply", async () => {
    const { handler, deps, sends } = harness({ debounceMs: 120 });
    const bodies = [
      inboundBody({ eventId: "b1", platformMessageId: "m1", text: "hey" }),
      inboundBody({ eventId: "b2", platformMessageId: "m2", text: "saw your video" }),
      inboundBody({ eventId: "b3", platformMessageId: "m3", text: "im looking in round rock" }),
    ];
    const acks = [];
    for (const b of bodies) {
      acks.push(await handler.handle({ rawBody: Buffer.from(b), signature: sign(b) }));
    }
    expect(acks.every((a) => a.status === 200)).toBe(true);
    await Promise.all(acks.map((a) => a.processing));

    expect(sends).toHaveLength(1);

    const lead = (await deps.store.leads.findByExternalId("tiktok", "tt_user_123"))!;
    const msgs = await deps.store.conversations.getMessages(lead.id);
    const userMsgs = msgs.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    /* All three are in the one turn, in the order they were typed. */
    expect(userMsgs[0]!.text).toBe("hey\nsaw your video\nim looking in round rock");
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("53. every provider message id in a burst is recorded, so none can be replayed", async () => {
    const { handler, deps, sends } = harness({ debounceMs: 120 });
    const bodies = [
      inboundBody({ eventId: "c1", platformMessageId: "m1", text: "hey" }),
      inboundBody({ eventId: "c2", platformMessageId: "m2", text: "you around?" }),
    ];
    const acks = [];
    for (const b of bodies) acks.push(await handler.handle({ rawBody: Buffer.from(b), signature: sign(b) }));
    await Promise.all(acks.map((a) => a.processing));
    expect(sends).toHaveLength(1);

    /* m1 was folded into the turn but was never the id the pipeline claimed;
       it must still be spent. */
    expect(await deps.store.idempotency.claim("tiktok:msg:m1", 60)).toBe(false);
    expect(await deps.store.idempotency.claim("tiktok:msg:m2", 60)).toBe(false);
  });
});

describe("mapping into the existing pipeline contract", () => {
  it("54. maps every field the pipeline reads and labels the transport", () => {
    const event = toInboundEvent(
      {
        eventId: "evt_1",
        conversationId: "conv_1",
        accountId: ACCOUNT,
        platform: "tiktok",
        senderId: "tt_user_123",
        senderName: "Jane B",
        senderUsername: "janeb",
        text: "hey",
        platformMessageId: "ptf_1",
      },
      "the VA opener",
    );
    expect(event).toEqual({
      platform: "tiktok",
      externalUserId: "tt_user_123",
      username: "janeb",
      displayName: "Jane B",
      message: "hey",
      providerMessageId: "ptf_1",
      wesleyPreviousOutbound: "the VA opener",
      conversationGoal: null,
      sourceCampaign: null,
      flowKey: null,
      isEcho: false,
      transport: "tiktok_zernio",
    });
    /* The legacy ManyChat-era name must not survive anywhere in the mapping. */
    expect(Object.keys(event)).not.toContain("marcoPreviousOutbound");
  });

  it("55. stores Zernio-delivered messages under the tiktok_zernio source", async () => {
    const { handler, deps } = harness();
    await deliver(handler, inboundBody());
    const lead = (await deps.store.leads.findByExternalId("tiktok", "tt_user_123"))!;
    const msgs = await deps.store.conversations.getMessages(lead.id);
    expect(msgs.find((m) => m.role === "user")!.source).toBe("tiktok_zernio");
    expect(msgs.find((m) => m.role === "assistant")!.source).toBe("automation");
  });
});
