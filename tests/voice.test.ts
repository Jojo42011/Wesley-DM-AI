import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ExampleStore, containsUnredactedPii } from "../src/voice/exampleStore.js";
import { renderExamples, retrieveExamples } from "../src/voice/exampleRetrieval.js";
import {
  approveExample,
  redactTranscript,
  splitIntoExamples,
} from "../src/voice/screenshotIngestion.js";
import { ConversationStage } from "../src/domain/types.js";
import type { VoiceExample } from "../src/domain/types.js";

function example(overrides: Partial<VoiceExample> = {}): VoiceExample {
  return {
    id: randomUUID(),
    thread: [{ role: "user", text: "how much do homes go for out there" }],
    targetResponse: "Depends on the area — most of my buyers land between the high 200s and low 400s.",
    situation: "price question",
    userIntent: "pricing",
    sentiment: "neutral",
    stage: ConversationStage.ValueOffered,
    objectionType: null,
    outcome: "continued",
    approved: true,
    qualityScore: 0.8,
    ...overrides,
  };
}

describe("voice pipeline", () => {
  it("#21 retrieval selects examples matching stage and sentiment first", () => {
    const store = new ExampleStore();
    const match = example({
      stage: ConversationStage.ContactRequested,
      sentiment: "skeptical",
      situation: "number hesitation",
    });
    store.addAll([
      example({ situation: "generic a" }),
      example({ situation: "generic b", sentiment: "positive" }),
      match,
      example({ situation: "generic c", stage: ConversationStage.New }),
    ]);

    const results = retrieveExamples(store, {
      stage: ConversationStage.ContactRequested,
      sentiment: "skeptical",
    });
    expect(results[0]!.id).toBe(match.id);
  });

  it("#22 unapproved screenshot examples are never used", () => {
    const store = new ExampleStore();
    const unapproved = example({ approved: false, situation: "not reviewed yet" });
    store.addAll([unapproved, example()]);

    expect(store.active().every((e) => e.approved)).toBe(true);
    const results = retrieveExamples(store, {
      stage: ConversationStage.ValueOffered,
      sentiment: "neutral",
    });
    expect(results.some((e) => e.id === unapproved.id)).toBe(false);
  });

  it("#23 unredacted personal data never appears in the voice prompt", () => {
    const store = new ExampleStore();
    const leaky = example({
      targetResponse: "Call me at 512-761-8330 or wesley@realty.com anytime!",
    });
    store.addAll([leaky, example()]);

    expect(containsUnredactedPii(leaky)).toBe(true);
    expect(store.active().some((e) => e.id === leaky.id)).toBe(false);

    const rendered = renderExamples(retrieveExamples(store, {
      stage: ConversationStage.ValueOffered,
      sentiment: "neutral",
    }));
    expect(rendered).not.toContain("512-761-8330");
    expect(rendered).not.toContain("wesley@realty.com");
  });

  it("ingestion redacts phones, emails, addresses and account numbers", () => {
    const redacted = redactTranscript({
      screenshotRef: "shot-01",
      bubbles: [
        { speaker: "person", text: "im at 4412 Maple Street, call 512 761 8330 or j.doe@mail.com" },
        { speaker: "wesley", text: "Got it — I'll reach out!" },
      ],
    });
    const text = redacted.bubbles[0]!.text;
    expect(text).toContain("[redacted-address]");
    expect(text).toContain("[redacted-phone]");
    expect(text).toContain("[redacted-email]");
    expect(text).not.toContain("8330");
  });

  it("splits transcripts into unapproved examples; approval is explicit", () => {
    const examples = splitIntoExamples(
      {
        screenshotRef: "shot-02",
        bubbles: [
          { speaker: "wesley", text: "Hey! Saw your comment — buying this year?" },
          { speaker: "person", text: "maybe, kinda nervous about rates tbh" },
          { speaker: "wesley", text: "Totally get that. Rates matter less than the right price — happy to walk you through it." },
        ],
      },
      () => ({
        situation: "rate objection",
        userIntent: "objection",
        sentiment: "skeptical",
        stage: ConversationStage.ValueOffered,
        objectionType: "rates",
        outcome: null,
      }),
    );
    expect(examples).toHaveLength(1);
    expect(examples[0]!.approved).toBe(false);

    const approved = approveExample(examples[0]!, 0.9);
    expect(approved.approved).toBe(true);
    expect(approved.qualityScore).toBe(0.9);
  });
});
