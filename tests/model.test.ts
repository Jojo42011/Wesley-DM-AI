import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { processInboundEvent } from "../src/app/dmPipeline.js";
import { validateReply } from "../src/app/responseValidator.js";
import { buildSystemPrompt, buildUserPrompt } from "../src/app/promptBuilder.js";
import { ReplySchema } from "../src/integrations/llm.js";
import { ConversationStage } from "../src/domain/types.js";
import type { Message, PreflightResult } from "../src/domain/types.js";
import { WESLEY_REALTOR_LEADS } from "../src/config/campaigns.js";
import { WESLEY_VOICE_PROFILE } from "../src/config/wesleyVoice.js";
import { makeDeps, makeEvent, makeLead, makeMessage, modelReply } from "./helpers.js";

const genSystem = "You write exactly one TikTok DM as Wesley";
const preflightSystem = "You review a DM conversation";

const basePreflight: PreflightResult = {
  userRepeated: false,
  wesleyRepeated: false,
  sentiment: "neutral",
  unansweredQuestions: [],
  closedTopics: [],
  nextObjective: "answer and advance",
  coachingNote: "",
  shouldReply: true,
  shouldEscalate: false,
};

async function seedConvo(
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

describe("model reply pathway", () => {
  it("#6 a direct question is answered before the CTA", async () => {
    const deps = makeDeps();
    await seedConvo(deps, [
      ["assistant", "Hey! Happy to help — buying or selling?"],
      ["user", "buying I think"],
    ]);

    let genPrompt = "";
    deps.llm.handler = (req) => {
      if (req.system.includes(preflightSystem)) {
        return { ...basePreflight, unansweredQuestions: ["How do pre-approvals work?"] };
      }
      if (req.system.includes(genSystem)) {
        genPrompt = req.system;
        return modelReply(
          "Pre-approval is just a lender checking what you can borrow, takes about a day. Want me to text you a couple lenders I trust?",
        );
      }
      return null;
    };

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "yo how do pre approvals even work lol" }),
    );
    expect(outcome.reply).toContain("Pre-approval");
    // The engine instructs the model to answer the question before any CTA.
    expect(genPrompt).toContain("Never ignore a direct question to force the CTA");
    expect(genPrompt).toContain("How do pre-approvals work?");
  });

  it("#7 a previously answered question is not asked again", () => {
    const lead = makeLead();
    const messages: Message[] = [];
    const result = validateReply(
      "So are you looking to buy or sell?",
      WESLEY_REALTOR_LEADS,
      lead,
      messages,
      { closedTopics: ["whether they are looking to buy or sell"] },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons.some((r) => r.startsWith("reasks_closed_topic"))).toBe(true);
  });

  it("#8 Wesley's last outbound is not repeated or closely paraphrased", async () => {
    const deps = makeDeps();
    const previous = "Easiest way to get you real answers is a quick text. What's the best number for you?";
    await seedConvo(deps, [["assistant", previous]], { stage: ConversationStage.ValueOffered });

    deps.llm.handler = (req) => {
      if (req.system.includes(preflightSystem)) return basePreflight;
      if (req.system.includes(genSystem)) {
        // Model keeps trying to reuse the same line (both attempts).
        return modelReply("Easiest way to get you real answers is a quick text — what's the best number for you??");
      }
      return null;
    };

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "hmm what makes you different from other agents" }),
    );
    // Rejected twice → deterministic fallback, which never equals the prior line.
    expect(outcome.decision).toBe("fallback_after_rejection");
    expect(outcome.reply).not.toBe(previous);
    const retried = deps.llm.calls.filter((c) => c.system.includes("RETROACTIVE_FIX"));
    expect(retried).toHaveLength(1);
  });

  it("#9 skeptical sentiment does not receive forced enthusiasm", () => {
    const lead = makeLead();
    const result = validateReply(
      "This is AMAZING!! You're going to absolutely love working with me!!",
      WESLEY_REALTOR_LEADS,
      lead,
      [],
      { sentiment: "skeptical" },
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("forced_enthusiasm");
  });

  it("#15 model failure uses a safe fallback instead of crashing", async () => {
    const deps = makeDeps();
    await seedConvo(deps, [["assistant", "Hey! What are you looking for?"]]);
    deps.llm.handler = () => new Error("provider 500");

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "im kinda thinking about selling next spring" }),
    );
    expect(outcome.reply).toBeTruthy();
    expect(outcome.decision).toBe("fallback_model_failure");
  });

  it("#16 invalid model JSON is rejected by schema validation", async () => {
    expect(ReplySchema.safeParse({ totally: "wrong" }).success).toBe(false);

    const deps = makeDeps();
    await seedConvo(deps, [["assistant", "Hey!"]]);
    deps.llm.handler = (req) =>
      req.system.includes(genSystem) ? { totally: "wrong shape" } : null;

    const outcome = await processInboundEvent(deps, makeEvent({ message: "hi again, one more question" }));
    expect(outcome.decision).toBe("fallback_model_failure");
    expect(outcome.reply).toBeTruthy();
  });

  it("#17 unsupported claims are rejected and never sent", async () => {
    const deps = makeDeps();
    await seedConvo(deps, [["assistant", "Hey! Happy to help."]]);

    deps.llm.handler = (req) => {
      if (req.system.includes(preflightSystem)) return basePreflight;
      if (req.system.includes(genSystem)) {
        return modelReply("We offer guaranteed approval with no credit check — let's get you in a house!");
      }
      return null;
    };

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "can u actually get me approved? my credit is rough" }),
    );
    expect(outcome.reply).toBeTruthy();
    expect(outcome.reply!.toLowerCase()).not.toContain("guaranteed approval");
    expect(outcome.reply!.toLowerCase()).not.toContain("no credit check");
  });

  it("#20 a long conversation retains unresolved questions and promises", () => {
    const lead = makeLead();
    const messages: Message[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(makeMessage({ leadId: lead.id, role: "user", text: `filler message ${i}` }));
      messages.push(makeMessage({ leadId: lead.id, role: "assistant", text: `filler reply ${i}` }));
    }
    const preflight: PreflightResult = {
      ...basePreflight,
      unansweredQuestions: ["What closing costs should I expect?"],
      closedTopics: ["their budget"],
      coachingNote: "You promised to send lender names — acknowledge that.",
    };
    const system = buildSystemPrompt({
      policy: WESLEY_REALTOR_LEADS,
      voiceProfile: WESLEY_VOICE_PROFILE,
      examples: [],
      lead,
      messages,
      latestUserMessage: "ok so what now",
      wesleyPreviousOutbound: null,
      preflight,
      capturedFields: [],
    });
    // Unresolved questions and commitments survive even when older turns
    // scroll out of the transcript window.
    expect(system).toContain("What closing costs should I expect?");
    expect(system).toContain("You promised to send lender names");
    expect(system).toContain("their budget");

    const user = buildUserPrompt({
      policy: WESLEY_REALTOR_LEADS,
      voiceProfile: WESLEY_VOICE_PROFILE,
      examples: [],
      lead,
      messages,
      latestUserMessage: "ok so what now",
      wesleyPreviousOutbound: null,
      preflight,
      capturedFields: [],
    });
    expect(user).toContain("filler reply 14"); // recent turns preserved
  });

  it("suppresses the reply when the model chooses silence", async () => {
    const deps = makeDeps();
    await seedConvo(deps, [["assistant", "I'll send that list over tomorrow morning!"]]);
    deps.llm.handler = (req) => {
      if (req.system.includes(preflightSystem)) return basePreflight;
      if (req.system.includes(genSystem)) return modelReply(null);
      return null;
    };
    const outcome = await processInboundEvent(deps, makeEvent({ message: "appreciate you man, we'll see" }));
    expect(outcome.reply).toBeNull();
    expect(outcome.decision).toBe("model_silence");
  });
});
