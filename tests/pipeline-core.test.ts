import { describe, expect, it } from "vitest";
import { processInboundEvent } from "../src/app/dmPipeline.js";
import { makeDeps, makeEvent, interestedGate, modelReply } from "./helpers.js";

const gateSystem = "classify whether an inbound TikTok DM";
const genSystem = "You write exactly one TikTok DM as Wesley";

describe("pipeline core", () => {
  it("#1 first inbound message creates one lead and one conversation", async () => {
    const deps = makeDeps();
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem))
        return modelReply("Hey! Happy to help — are you buying or selling?");
      return null;
    };

    const outcome = await processInboundEvent(deps, makeEvent());
    expect(outcome.reply).toBeTruthy();
    expect(await deps.store.leads.count()).toBe(1);

    const messages = await deps.store.conversations.getMessages(outcome.leadId!);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("#2 a manual Wesley opener is seeded exactly once", async () => {
    const deps = makeDeps();
    deps.llm.handler = (req) =>
      req.system.includes(genSystem) ? modelReply("Nice — what area are you looking in?") : null;

    const opener = "Hey! Saw your comment on my video — you looking to buy this year?";
    const first = await processInboundEvent(
      deps,
      makeEvent({ message: "yes actually!", wesleyPreviousOutbound: opener }),
    );
    const second = await processInboundEvent(
      deps,
      makeEvent({
        message: "we want something near downtown",
        providerMessageId: "msg_2",
        wesleyPreviousOutbound: opener, // ManyChat may resend it — must not reseed
      }),
    );

    expect(first.leadId).toBe(second.leadId);
    const messages = await deps.store.conversations.getMessages(first.leadId!);
    const seeds = messages.filter((m) => m.source === "manual_seed");
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.text).toBe(opener);
    // Replying to a seeded opener skips the cold-lead intent gate entirely.
    expect(deps.llm.calls.some((c) => c.system.includes(gateSystem))).toBe(false);
  });

  it("#3 a repeated webhook message ID produces no second reply", async () => {
    const deps = makeDeps();
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem)) return modelReply("Hey! What can I help with?");
      return null;
    };

    const event = makeEvent({ providerMessageId: "dup_1" });
    const first = await processInboundEvent(deps, event);
    const second = await processInboundEvent(deps, { ...event });

    expect(first.reply).toBeTruthy();
    expect(second.reply).toBeNull();
    expect(second.decision).toBe("duplicate_ignored");
    const messages = await deps.store.conversations.getMessages(first.leadId!);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("#4 two rapid distinct messages are serialized, never dropped", async () => {
    const deps = makeDeps();
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem)) return modelReply("Got you — tell me more!");
      return null;
    };

    const [a, b] = await Promise.all([
      processInboundEvent(deps, makeEvent({ message: "do you work with first time buyers?", providerMessageId: "r1" })),
      processInboundEvent(deps, makeEvent({ message: "also is Austin too expensive rn??", providerMessageId: "r2" })),
    ]);

    expect(await deps.store.leads.count()).toBe(1);
    const leadId = a.leadId ?? b.leadId;
    const messages = await deps.store.conversations.getMessages(leadId!);
    const userTexts = messages.filter((m) => m.role === "user").map((m) => m.text);
    expect(userTexts).toHaveLength(2);
    expect(userTexts).toContain("do you work with first time buyers?");
    expect(userTexts).toContain("also is Austin too expensive rn??");
  });

  it("ignores echo events", async () => {
    const deps = makeDeps();
    const outcome = await processInboundEvent(deps, makeEvent({ isEcho: true }));
    expect(outcome.decision).toBe("echo_ignored");
    expect(await deps.store.leads.count()).toBe(0);
  });

  it("rejects spam at the intent gate without creating a lead", async () => {
    const deps = makeDeps();
    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "We can grow your page — check out my profile! f4f" }),
    );
    expect(outcome.decision).toContain("gate_rejected");
    expect(await deps.store.leads.count()).toBe(0);
  });
});
