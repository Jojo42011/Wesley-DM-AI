import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { processInboundEvent } from "../src/app/dmPipeline.js";
import { ConversationStage } from "../src/domain/types.js";
import { WESLEY_REALTOR_LEADS } from "../src/config/campaigns.js";
import { makeDeps, makeEvent, makeLead, makeMessage, interestedGate, modelReply } from "./helpers.js";

const gateSystem = "classify whether an inbound TikTok DM";
const genSystem = "You write exactly one TikTok DM as Wesley";

async function seedConversation(
  deps: ReturnType<typeof makeDeps>,
  turns: Array<["user" | "assistant", string]>,
  leadOverrides = {},
) {
  const lead = makeLead(leadOverrides);
  await deps.store.leads.create(lead);
  let t = Date.now() - turns.length * 60000;
  for (const [role, text] of turns) {
    await deps.store.conversations.appendMessage(
      makeMessage({ id: randomUUID(), leadId: lead.id, role, text, createdAt: new Date(t).toISOString() }),
    );
    t += 60000;
  }
  return lead;
}

describe("deterministic guards", () => {
  it("#14 a simple thanks after a commitment results in silence", async () => {
    const deps = makeDeps();
    await seedConversation(deps, [
      ["assistant", "Easiest way is a quick text — what's your number?"],
      ["user", "512 761 8330"],
      ["assistant", "Perfect, got it. I'll reach out shortly!"],
    ], { phone: "+15127618330", stage: ConversationStage.ContactCaptured });

    const outcome = await processInboundEvent(deps, makeEvent({ message: "thank you!!" }));
    expect(outcome.reply).toBeNull();
    expect(outcome.suppressed).toBe(true);
    expect(outcome.decision).toBe("silence_after_ack");
  });

  it("#18 opt-out immediately suppresses automation and is durable", async () => {
    const deps = makeDeps();
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem)) return modelReply("hey!");
      return null;
    };

    const first = await processInboundEvent(deps, makeEvent({ message: "im interested in buying" }));
    const optOut = await processInboundEvent(
      deps,
      makeEvent({ message: "actually stop messaging me", providerMessageId: "oo1" }),
    );
    expect(optOut.decision).toBe("opt_out");
    expect(optOut.reply).toBe(WESLEY_REALTOR_LEADS.optOutConfirmation);

    const after = await processInboundEvent(
      deps,
      makeEvent({ message: "hello?", providerMessageId: "oo2" }),
    );
    expect(after.reply).toBeNull();
    expect(after.decision).toBe("suppressed_opt_out");

    const lead = await deps.store.leads.get(first.leadId!);
    expect(lead!.optedOut).toBe(true);
  });

  it("#13 a refusal receives a lower-pressure response, not repeated nagging", async () => {
    const deps = makeDeps();
    await seedConversation(deps, [
      ["assistant", "Easiest way to get you real answers is a quick text. What's the best number for you?"],
    ], { stage: ConversationStage.ContactRequested });

    const first = await processInboundEvent(
      deps,
      makeEvent({ message: "nah im not giving my number out sorry" }),
    );
    expect(first.decision).toBe("cta_refused");
    expect(WESLEY_REALTOR_LEADS.fallbackResponses.cta_resistance).toContain(first.reply);
    // Never re-asks for the number.
    expect(first.reply!.toLowerCase()).not.toContain("number");

    // A second refusal must not repeat the previous response.
    const second = await processInboundEvent(
      deps,
      makeEvent({ message: "seriously, I'd rather not share my phone", providerMessageId: "rf2" }),
    );
    expect(second.decision).toBe("cta_refused");
    expect(second.reply).not.toBe(first.reply);
  });

  it("escalates to human review on 'is this a bot' with an approved ack", async () => {
    const deps = makeDeps();
    await seedConversation(deps, [["assistant", "Hey! How can I help?"]]);

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "is this a bot? I want to talk to wesley" }),
    );
    expect(outcome.decision).toContain("escalated");
    expect(outcome.stageAfter).toBe(ConversationStage.HumanReview);
    expect(WESLEY_REALTOR_LEADS.fallbackResponses.human_handoff).toContain(outcome.reply);
  });

  it("answers a pinned direct question deterministically (typos and slang ok)", async () => {
    const deps = makeDeps();
    await seedConversation(deps, [["assistant", "Hey! How can I help?"]]);

    const outcome = await processInboundEvent(deps, makeEvent({ message: "wait is it free??" }));
    expect(outcome.decision).toBe("pinned_answer");
    expect(outcome.reply).toContain("zero obligation");
  });

  it("handles 'I already sent it' when nothing was received", async () => {
    const deps = makeDeps();
    await seedConversation(deps, [
      ["assistant", "What's the best number for you?"],
    ], { stage: ConversationStage.ContactRequested });

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "i already sent it to you yesterday" }),
    );
    expect(outcome.decision).toBe("already_sent_not_received");
    expect(WESLEY_REALTOR_LEADS.fallbackResponses.info_already_sent).toContain(outcome.reply);
  });

  it("moves to the deterministic CTA when the person agrees", async () => {
    const deps = makeDeps();
    await seedConversation(deps, [
      ["assistant", "I can send you a list of homes under 400k — want me to?"],
    ], { stage: ConversationStage.ValueOffered });

    const outcome = await processInboundEvent(deps, makeEvent({ message: "yes lets do it!" }));
    expect(outcome.decision).toBe("agreement_cta");
    expect(outcome.stageAfter).toBe(ConversationStage.ContactRequested);
    expect(WESLEY_REALTOR_LEADS.fallbackResponses.cta_request).toContain(outcome.reply);
  });

  it("stays silent on a goodbye after a commitment", async () => {
    const deps = makeDeps();
    await seedConversation(deps, [
      ["assistant", "Perfect, got it. I'll reach out shortly!"],
    ], { phone: "+15127618330", stage: ConversationStage.ContactCaptured });

    const outcome = await processInboundEvent(deps, makeEvent({ message: "ok bye, have a good one" }));
    expect(outcome.reply).toBeNull();
    expect(outcome.decision).toBe("closeout_silent");
    expect(outcome.stageAfter).toBe(ConversationStage.Closed);
  });
});
