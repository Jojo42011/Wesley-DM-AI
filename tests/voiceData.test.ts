import { describe, expect, it } from "vitest";
import path from "node:path";
import { ExampleStore } from "../src/voice/exampleStore.js";
import { retrieveExamples } from "../src/voice/exampleRetrieval.js";
import { ConversationStage } from "../src/domain/types.js";
import { WESLEY_REALTOR_LEADS } from "../src/config/campaigns.js";

const DATA = path.resolve("data", "voice-examples.json");

describe("shipped Wesley voice data (from the 55 real conversations)", () => {
  const store = new ExampleStore();
  store.loadFromFile(DATA);

  it("loads a substantial approved, PII-clean library", () => {
    expect(store.all().length).toBeGreaterThanOrEqual(60);
    expect(store.active().length).toBe(store.all().length); // nothing PII-flagged
    expect(store.all().every((e) => e.approved)).toBe(true);
  });

  it("no example teaches hyphens or em dashes", () => {
    for (const e of store.all()) {
      expect(e.targetResponse).not.toMatch(/[—–]/);
      expect(e.targetResponse).not.toMatch(/\p{L}-\p{L}/u);
    }
  });

  it("no raw phone numbers, emails, or links survive redaction", () => {
    for (const e of store.all()) {
      const texts = [e.targetResponse, ...e.thread.map((t) => t.text)];
      for (const t of texts) {
        expect(t).not.toMatch(/\+?\d[\d\s().-]{7,}\d/);
        expect(t).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
        expect(t).not.toMatch(/https?:\/\//);
      }
    }
  });

  it("a fresh keyword lead retrieves his real openers", () => {
    const fresh = retrieveExamples(store, { stage: ConversationStage.New, sentiment: "neutral" });
    expect(fresh.length).toBeGreaterThanOrEqual(3);
    expect(fresh.some((e) => e.targetResponse.includes("detailed breakdown"))).toBe(true);
  });

  it("covers the fail cases too, not just wins", () => {
    const outcomes = new Set(store.all().map((e) => e.outcome));
    expect([...outcomes].some((o) => o && o !== "number_obtained")).toBe(true);
  });

  it("campaign fallbacks and pinned answers are dash-free", () => {
    const all = [
      ...Object.values(WESLEY_REALTOR_LEADS.fallbackResponses).flat(),
      ...WESLEY_REALTOR_LEADS.pinnedAnswers.map((p) => p.answer),
      WESLEY_REALTOR_LEADS.optOutConfirmation,
    ];
    for (const t of all) {
      expect(t).not.toMatch(/[—–]/);
      expect(t).not.toMatch(/\p{L}-\p{L}/u);
    }
  });
});

import { runIntentGate } from "../src/modules/intentGate.js";
import { buildSystemPrompt } from "../src/app/promptBuilder.js";
import { WESLEY_VOICE_PROFILE } from "../src/config/wesleyVoice.js";
import { FakeLlm } from "../src/integrations/llm.js";
import { makeLead } from "./helpers.js";

describe("keyword leads and unknown property facts", () => {
  it("bare video keywords always pass the intent gate, even with no classifier", async () => {
    const llm = new FakeLlm(); // returns null → classifier unavailable
    for (const kw of ["LAZY RIVER", "sunset", "Elevator", "koi pond"]) {
      const gate = await runIntentGate(llm, WESLEY_REALTOR_LEADS, kw);
      expect(gate.action).toBe("accept");
    }
    expect(llm.calls.length).toBe(0); // deterministic, no model needed
  });

  it("the prompt forbids inventing property facts", () => {
    const system = buildSystemPrompt({
      policy: WESLEY_REALTOR_LEADS,
      voiceProfile: WESLEY_VOICE_PROFILE,
      examples: [],
      lead: makeLead(),
      messages: [],
      latestUserMessage: "how much is that house and where is it",
      wesleyPreviousOutbound: null,
      preflight: {
        userRepeated: false, wesleyRepeated: false, sentiment: "neutral",
        unansweredQuestions: [], closedTopics: [], nextObjective: "answer",
        coachingNote: "", shouldReply: true, shouldEscalate: false,
      },
      capturedFields: [],
    });
    expect(system).toContain("FACTS YOU MAY NOT USE");
    expect(system).toContain("Never state or guess");
  });
});
