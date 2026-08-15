import { randomUUID } from "node:crypto";
import type { VoiceExample } from "../domain/types.js";
import { ConversationStage } from "../domain/types.js";

/**
 * Screenshot ingestion pipeline for Wesley's 50 real conversations.
 *
 * Stages:
 *  1. OCR / manual transcription (external — produces RawTranscript)
 *  2. Bubble attribution (who said what), chronological order preserved
 *  3. Redaction of phones, emails, addresses, account numbers
 *  4. Splitting into individual response examples
 *  5. Tagging (situation, intent, sentiment, stage, objection, outcome)
 *  6. HUMAN REVIEW — examples start approved:false and only a reviewer
 *     flips them; unapproved examples are never used at generation time.
 */

export interface RawTranscriptBubble {
  speaker: "wesley" | "person";
  text: string;
}

export interface RawTranscript {
  screenshotRef: string;
  bubbles: RawTranscriptBubble[];
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]"],
  [/\b\d{1,5}\s+\w+\s+(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|ct|court)\b/gi, "[redacted-address]"],
  [/\b\d{8,17}\b/g, "[redacted-account]"],
];

export function redactTranscript(t: RawTranscript): RawTranscript {
  return {
    ...t,
    bubbles: t.bubbles.map((b) => {
      let text = b.text;
      for (const [re, sub] of REDACTIONS) text = text.replace(re, sub);
      return { ...b, text };
    }),
  };
}

export interface ExampleTags {
  situation: string;
  userIntent: string;
  sentiment: string;
  stage: ConversationStage;
  objectionType: string | null;
  outcome: string | null;
}

/**
 * Splits a redacted transcript into one example per Wesley response that
 * follows at least one person message. Examples are created UNAPPROVED.
 */
export function splitIntoExamples(
  transcript: RawTranscript,
  tagFor: (threadSoFar: RawTranscriptBubble[], reply: string) => ExampleTags,
): VoiceExample[] {
  const redacted = redactTranscript(transcript);
  const examples: VoiceExample[] = [];
  const thread: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (const bubble of redacted.bubbles) {
    if (bubble.speaker === "wesley") {
      const hasUserTurn = thread.some((t) => t.role === "user");
      if (hasUserTurn) {
        const tags = tagFor(
          thread.map((t) => ({
            speaker: t.role === "assistant" ? ("wesley" as const) : ("person" as const),
            text: t.text,
          })),
          bubble.text,
        );
        examples.push({
          id: randomUUID(),
          thread: [...thread],
          targetResponse: bubble.text,
          ...tags,
          approved: false, // human review required before activation
          qualityScore: 0,
        });
      }
      thread.push({ role: "assistant", text: bubble.text });
    } else {
      thread.push({ role: "user", text: bubble.text });
    }
  }
  return examples;
}

/** Human review action — the ONLY way an example becomes active. */
export function approveExample(example: VoiceExample, qualityScore: number): VoiceExample {
  return { ...example, approved: true, qualityScore };
}
