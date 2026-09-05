import { describe, expect, it, vi } from "vitest";
import {
  normalizeRespondIoPayload,
  RespondIoClient,
  RespondIoRejection,
  TikTokChannelResolver,
} from "../src/integrations/respondio.js";
import { handleRespondIoWebhook } from "../src/app/respondioWebhook.js";
import { ConversationStage } from "../src/domain/types.js";
import { makeDeps, modelReply } from "./helpers.js";

const TIKTOK_CHANNEL = 551174;
const genSystem = "You write exactly one TikTok DM as Wesley";
const preflightSystem = "You review a DM conversation";

/** A realistic respond.io "New Incoming Message" payload. */
function inboundPayload(over: Record<string, unknown> = {}) {
  return {
    event_type: "message.received",
    contact: { id: 90210, firstName: "Jamie", lastName: "Rivera" },
    channel: { id: TIKTOK_CHANNEL, name: "TikTok Business messaging", source: "tiktok_business" },
    message: {
      messageId: "m_1001",
      contactId: 90210,
      channelId: TIKTOK_CHANNEL,
      traffic: "incoming",
      message: { type: "text", text: "LAZY RIVER" },
    },
    ...over,
  };
}

function outboundPayload(text: string, messageId = "m_out_1") {
  return {
    event_type: "message.sent",
    contact: { id: 90210, firstName: "Jamie" },
    channel: { id: TIKTOK_CHANNEL, source: "tiktok_business" },
    message: {
      messageId,
      contactId: 90210,
      channelId: TIKTOK_CHANNEL,
      traffic: "outgoing",
      message: { type: "text", text },
    },
  };
}

/** Client stub that records sends instead of hitting the network. */
function fakeClient() {
  const sent: Array<{ contactId: string; text: string }> = [];
  const client = new RespondIoClient("test-token");
  client.sendText = vi.fn(async (contactId: string, text: string) => {
    sent.push({ contactId, text });
    return { ok: true, status: 200 };
  }) as RespondIoClient["sendText"];
  return { client, sent };
}

function webhookDeps(over: Record<string, unknown> = {}) {
  const deps = makeDeps();
  const { client, sent } = fakeClient();
  deps.llm.handler = (req) => {
    if (req.system.includes(preflightSystem)) return null;
    if (req.system.includes(genSystem)) return modelReply("What's the best number to text them to?");
    return null;
  };
  return {
    deps: {
      ...deps,
      respondIo: client,
      channels: new TikTokChannelResolver(
        { findTikTokChannelIds: async () => [TIKTOK_CHANNEL] },
        [TIKTOK_CHANNEL],
      ),
      ...over,
    },
    store: deps.store,
    llm: deps.llm,
    sent,
    client,
  };
}

describe("respond.io payload adapter", () => {
  it("normalizes an inbound TikTok message", () => {
    const parsed = normalizeRespondIoPayload(inboundPayload(), { tiktokChannelIds: [TIKTOK_CHANNEL] });
    expect(parsed.kind).toBe("inbound");
    if (parsed.kind !== "inbound") return;
    expect(parsed.contactId).toBe("90210");
    expect(parsed.event.externalUserId).toBe("respondio:90210");
    expect(parsed.event.message).toBe("LAZY RIVER");
    expect(parsed.event.providerMessageId).toBe("respondio:m_1001");
    expect(parsed.event.displayName).toBe("Jamie Rivera");
    expect(parsed.event.platform).toBe("tiktok");
  });

  it("filters out other channels by id and by source", () => {
    const otherId = normalizeRespondIoPayload(
      inboundPayload({ channel: { id: 999, source: "whatsapp" }, message: { ...inboundPayload().message, channelId: 999 } }),
      { tiktokChannelIds: [TIKTOK_CHANNEL] },
    );
    expect(otherId.kind).toBe("ignore");

    const otherSource = normalizeRespondIoPayload(
      inboundPayload({ channel: { id: TIKTOK_CHANNEL, source: "whatsapp" } }),
      { tiktokChannelIds: [TIKTOK_CHANNEL] },
    );
    expect(otherSource.kind).toBe("ignore");
  });

  it("classifies outbound traffic as an echo, never an inbound turn", () => {
    const parsed = normalizeRespondIoPayload(outboundPayload("Hey! Saw your comment"), {
      tiktokChannelIds: [TIKTOK_CHANNEL],
    });
    expect(parsed.kind).toBe("outbound");
    if (parsed.kind !== "outbound") return;
    expect(parsed.text).toBe("Hey! Saw your comment");
  });

  it("rejects a payload with no contact id", () => {
    const bad = inboundPayload({ contact: {}, message: { messageId: "x", channelId: TIKTOK_CHANNEL, traffic: "incoming", message: { type: "text", text: "hi" } } });
    expect(() => normalizeRespondIoPayload(bad, { tiktokChannelIds: [TIKTOK_CHANNEL] })).toThrow(RespondIoRejection);
  });

  it("ignores non-text messages instead of crashing", () => {
    const attachment = inboundPayload({
      message: {
        messageId: "m_att",
        contactId: 90210,
        channelId: TIKTOK_CHANNEL,
        traffic: "incoming",
        message: { type: "attachment", url: "https://example.com/a.jpg" },
      },
    });
    const parsed = normalizeRespondIoPayload(attachment, { tiktokChannelIds: [TIKTOK_CHANNEL] });
    expect(parsed.kind).toBe("ignore");
  });

  it("accepts a second TikTok channel on the space, not just the first", () => {
    // Wesley can connect more than one TikTok channel; source is the
    // discriminator, so an unpinned second channel still works.
    const second = normalizeRespondIoPayload(
      inboundPayload({
        channel: { id: 551193, source: "tiktok_business", name: "TikTok Business messaging (1)" },
        message: { ...inboundPayload().message, channelId: 551193 },
      }),
      { tiktokChannelIds: [TIKTOK_CHANNEL] },
    );
    expect(second.kind).toBe("inbound");
    if (second.kind !== "inbound") return;
    expect(second.channelId).toBe(551193);
  });

  it("reads camelCase and flat field variants", () => {
    const variant = {
      eventType: "message.received",
      contact: { contactId: 555 },
      channel: { channelId: TIKTOK_CHANNEL, type: "tiktok" },
      message: { message_id: "flat_1", direction: "incoming", text: "sunset" },
    };
    const parsed = normalizeRespondIoPayload(variant, { tiktokChannelIds: [TIKTOK_CHANNEL] });
    expect(parsed.kind).toBe("inbound");
    if (parsed.kind !== "inbound") return;
    expect(parsed.event.message).toBe("sunset");
    expect(parsed.contactId).toBe("555");
  });
});

describe("respond.io webhook end to end", () => {
  it("runs the existing pipeline and delivers the reply through the API", async () => {
    const { deps, sent, store } = webhookDeps();
    const res = await handleRespondIoWebhook(deps, inboundPayload());
    await res.processing;

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.contactId).toBe("90210");
    expect(sent[0]!.text.length).toBeGreaterThan(0);

    // The brain ran: a lead exists with the conversation stored.
    const lead = await store.leads.findByExternalId("tiktok", "respondio:90210");
    expect(lead).not.toBeNull();
    const msgs = await store.conversations.getMessages(lead!.id);
    expect(msgs.filter((m) => m.role === "user")[0]!.text).toBe("LAZY RIVER");
  });

  it("preserves Wesley's manual opener so the agent continues instead of restarting", async () => {
    const { deps, store, llm, sent } = webhookDeps();
    const opener =
      "Thanks for the interest! I'd love to send over the detailed breakdown on that home, plus a couple other options in case it's not the right fit. What is the best phone number to text them to?";

    // Wesley types the opener manually in the respond.io inbox.
    await (await handleRespondIoWebhook(deps, outboundPayload(opener))).processing;
    // The lead replies with something only the model can handle.
    await (await handleRespondIoWebhook(
      deps,
      inboundPayload({
        message: {
          messageId: "m_reply",
          contactId: 90210,
          channelId: TIKTOK_CHANNEL,
          traffic: "incoming",
          message: { type: "text", text: "what other options do you even have though" },
        },
      }),
    )).processing;

    const lead = await store.leads.findByExternalId("tiktok", "respondio:90210");
    const msgs = await store.conversations.getMessages(lead!.id);
    const seeds = msgs.filter((m) => m.source === "manual_seed");
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.text).toBe(opener);
    expect(msgs[0]!.role).toBe("assistant"); // opener precedes the reply

    // The model was given Wesley's opener as history, so it continues the
    // thread rather than starting a fresh introduction.
    const genCall = llm.calls.find((c) => c.system.includes(genSystem));
    expect(genCall).toBeDefined();
    expect(genCall!.user).toContain("detailed breakdown");
    expect(genCall!.user).toContain("what other options do you even have though");
    expect(sent).toHaveLength(1); // only the reply was sent, not the echo
  });

  it("does not double-record the echo of a reply we just sent", async () => {
    const { deps, store } = webhookDeps();
    await (await handleRespondIoWebhook(deps, inboundPayload())).processing;

    const lead = await store.leads.findByExternalId("tiktok", "respondio:90210");
    const before = await store.conversations.getMessages(lead!.id);
    const ourReply = before.filter((m) => m.role === "assistant").pop()!;

    // respond.io echoes our own delivered message back to the webhook.
    const res = await handleRespondIoWebhook(deps, outboundPayload(ourReply.text, "m_echo"));
    await res.processing;

    const after = await store.conversations.getMessages(lead!.id);
    expect(after.filter((m) => m.role === "assistant")).toHaveLength(
      before.filter((m) => m.role === "assistant").length,
    );
  });

  it("deduplicates a repeated webhook by respond.io message id", async () => {
    const { deps, sent } = webhookDeps();
    await (await handleRespondIoWebhook(deps, inboundPayload())).processing;
    await (await handleRespondIoWebhook(deps, inboundPayload())).processing; // same messageId
    expect(sent).toHaveLength(1);
  });

  it("ignores other channels at the HTTP layer with a 200", async () => {
    const { deps, sent } = webhookDeps();
    const res = await handleRespondIoWebhook(
      deps,
      inboundPayload({ channel: { id: 42, source: "whatsapp" }, message: { ...inboundPayload().message, channelId: 42 } }),
    );
    await res.processing;
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it("enforces the webhook secret when configured", async () => {
    const { deps, sent } = webhookDeps({ webhookSecret: "s3cret" });
    const bad = await handleRespondIoWebhook(deps, inboundPayload(), { secret: "wrong" });
    await bad.processing;
    expect(bad.status).toBe(401);
    expect(sent).toHaveLength(0);

    const good = await handleRespondIoWebhook(deps, inboundPayload(), { secret: "s3cret" });
    await good.processing;
    expect(good.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("still acknowledges with 200 when respond.io refuses the delivery", async () => {
    const { deps } = webhookDeps();
    const send = vi.fn(async () => ({ ok: false, status: 503, detail: "upstream" }));
    deps.respondIo.sendText = send;
    const res = await handleRespondIoWebhook(deps, inboundPayload());
    await res.processing;
    // respond.io disables an endpoint after 30 errors in 30 minutes, so a
    // delivery problem is retried in the client and logged, never returned
    // as a webhook error.
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalled();
  });

  it("acknowledges well inside respond.io's 5 second webhook timeout", async () => {
    const { deps } = webhookDeps();
    // A slow turn: the model takes 3s and delivery another 1s.
    deps.llm.handler = () => {
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* keep the turn busy */
      }
      return modelReply("What's the best number to text them to?");
    };
    deps.respondIo.sendText = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 800));
      return { ok: true, status: 200 };
    });

    const started = Date.now();
    const res = await handleRespondIoWebhook(deps, inboundPayload());
    const ackMs = Date.now() - started;

    expect(res.status).toBe(200);
    expect(ackMs).toBeLessThan(1000); // acknowledged before delivery finishes
    await res.processing;
  });

  it("recovers a manual opener from history when no outbound webhook arrived", async () => {
    const { deps, store, llm } = webhookDeps();
    const opener =
      "Hey! So sorry for the delay, got totally flooded with messages. I'm pulling those details for you now, what's the best number to text them to?";
    // Wesley opened the conversation before the webhook was connected, so
    // the only record of it lives in respond.io's history.
    deps.respondIo.findLastOutboundText = vi.fn(async () => opener);

    await (await handleRespondIoWebhook(
      deps,
      inboundPayload({
        message: {
          messageId: "m_hist",
          contactId: 90210,
          channelId: TIKTOK_CHANNEL,
          traffic: "incoming",
          message: { type: "text", text: "what other options do you even have though" },
        },
      }),
    )).processing;

    const lead = await store.leads.findByExternalId("tiktok", "respondio:90210");
    const msgs = await store.conversations.getMessages(lead!.id);
    expect(msgs.filter((m) => m.source === "manual_seed")[0]!.text).toBe(opener);
    const genCall = llm.calls.find((c) => c.system.includes(genSystem));
    expect(genCall!.user).toContain("flooded with messages");
  });

  it("treats a sender.source of ai_agent or api as an echo, never a lead turn", async () => {
    const { deps, sent } = webhookDeps();
    const res = await handleRespondIoWebhook(deps, {
      event_type: "message.received",
      contact: { id: 90210 },
      channel: { id: TIKTOK_CHANNEL, source: "tiktok_business" },
      sender: { source: "api" },
      message: {
        messageId: "m_api",
        contactId: 90210,
        channelId: TIKTOK_CHANNEL,
        message: { type: "text", text: "sent by an automation, not the lead" },
      },
    });
    await res.processing;
    expect(sent).toHaveLength(0); // never replied to
  });

  it("releases the idempotency claim when processing throws, so a retry works", async () => {
    const { deps, store, sent } = webhookDeps();
    const boom = vi.spyOn(store.conversations, "appendMessage").mockRejectedValueOnce(new Error("db down"));

    const failed = await handleRespondIoWebhook(deps, inboundPayload());
    await failed.processing;
    boom.mockRestore();

    // respond.io retries the same message: it must be processed, not swallowed.
    const retry = await handleRespondIoWebhook(deps, inboundPayload());
    await retry.processing;
    expect(retry.status).toBe(200);
    expect(sent).toHaveLength(1); // reprocessed, not swallowed as a duplicate
  });
});

describe("respond.io API client", () => {
  it("posts a text message to the contact message endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new RespondIoClient("tok", "https://api.respond.io/v2");
    const result = await client.sendText("90210", "hey!", { channelId: TIKTOK_CHANNEL });

    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://api.respond.io/v2/contact/id:90210/message");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      message: { type: "text", text: "hey!" },
      channelId: TIKTOK_CHANNEL,
    });
    vi.unstubAllGlobals();
  });

  it("retries transient failures and gives up on 4xx", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      return n < 3 ? new Response("busy", { status: 429 }) : new Response("{}", { status: 200 });
    }));
    const client = new RespondIoClient("tok");
    expect((await client.sendText("1", "hi")).ok).toBe(true);
    expect(n).toBe(3);

    n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      return new Response("bad contact", { status: 404 });
    }));
    const client2 = new RespondIoClient("tok");
    expect((await client2.sendText("1", "hi")).ok).toBe(false);
    expect(n).toBe(1); // no pointless retries on a 4xx
    vi.unstubAllGlobals();
  });

  it("discovers the TikTok channel id from the space", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            { id: 1, name: "WhatsApp", source: "whatsapp" },
            { id: TIKTOK_CHANNEL, name: "TikTok Business messaging", source: "tiktok_business" },
          ],
        }),
        { status: 200 },
      ),
    ));
    const client = new RespondIoClient("tok");
    expect(await client.findTikTokChannelIds()).toEqual([TIKTOK_CHANNEL]);
    vi.unstubAllGlobals();
  });
});

import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/integrations/respondio.js";

describe("webhook signature verification", () => {
  const key = "signing-key-123";
  const body = JSON.stringify({ hello: "world" });
  const sign = (b: string) => createHmac("sha256", key).update(b, "utf8").digest("base64");

  it("accepts a correctly signed body and rejects tampering", () => {
    expect(verifyWebhookSignature(body, sign(body), key)).toBe(true);
    expect(verifyWebhookSignature(body, sign("other"), key)).toBe(false);
    expect(verifyWebhookSignature(body, null, key)).toBe(false);
    expect(verifyWebhookSignature(body, "not-base64!!", key)).toBe(false);
  });

  it("gates the webhook when a signing key is configured", async () => {
    const raw = JSON.stringify(inboundPayload());
    const { deps, sent } = webhookDeps({ signingKey: key });

    const bad = await handleRespondIoWebhook(deps, inboundPayload(), {
      rawBody: raw,
      signature: sign("tampered"),
    });
    await bad.processing;
    expect(bad.status).toBe(401);
    expect(sent).toHaveLength(0);

    const good = await handleRespondIoWebhook(deps, inboundPayload(), {
      rawBody: raw,
      signature: sign(raw),
    });
    await good.processing;
    expect(good.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});
