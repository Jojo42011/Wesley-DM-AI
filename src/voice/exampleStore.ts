import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import type { VoiceExample } from "../domain/types.js";
import { ConversationStage } from "../domain/types.js";

/**
 * Voice example store. Examples come from Wesley's transcribed, redacted,
 * tagged and HUMAN-APPROVED screenshot conversations. Unapproved examples
 * are never served to the generation layer.
 */

const VoiceExampleSchema = z.object({
  id: z.string(),
  thread: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string() })),
  targetResponse: z.string(),
  situation: z.string(),
  userIntent: z.string(),
  sentiment: z.string(),
  stage: z.nativeEnum(ConversationStage),
  objectionType: z.string().nullable(),
  outcome: z.string().nullable(),
  approved: z.boolean(),
  qualityScore: z.number(),
});

const PII_PATTERNS = [
  /\+?\d[\d\s().-]{7,}\d/, // phone
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\b\d{1,5}\s+\w+\s+(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|ct|court)\b/i, // address
];

export function containsUnredactedPii(example: VoiceExample): boolean {
  const texts = [example.targetResponse, ...example.thread.map((t) => t.text)];
  return texts.some((t) => PII_PATTERNS.some((re) => re.test(t)));
}

export class ExampleStore {
  private examples: VoiceExample[] = [];

  /** Loads examples; silently skips a missing file (pre-ingestion state). */
  loadFromFile(path: string): void {
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = z.array(VoiceExampleSchema).safeParse(raw);
    if (parsed.success) this.examples = parsed.data;
  }

  addAll(examples: VoiceExample[]): void {
    this.examples.push(...examples);
  }

  /**
   * Only approved, PII-clean examples are ever active. Redacted personal
   * data must never appear in the voice prompt.
   */
  active(): VoiceExample[] {
    return this.examples.filter((e) => e.approved && !containsUnredactedPii(e));
  }

  all(): VoiceExample[] {
    return [...this.examples];
  }
}
