import type { VoiceExample } from "../domain/types.js";
import { ConversationStage } from "../domain/types.js";
import type { ExampleStore } from "./exampleStore.js";

/**
 * Retrieves 3–8 approved examples matching the current situation — never
 * the whole corpus. Scoring: stage > sentiment > intent > objection,
 * with quality as a tiebreaker.
 */

export interface RetrievalQuery {
  stage: ConversationStage;
  sentiment: string;
  userIntent?: string;
  objectionType?: string | null;
}

export function retrieveExamples(
  store: ExampleStore,
  query: RetrievalQuery,
  max = 6,
): VoiceExample[] {
  const min = 3;
  const scored = store.active().map((e) => {
    let score = 0;
    if (e.stage === query.stage) score += 4;
    if (e.sentiment === query.sentiment) score += 3;
    if (query.userIntent && e.userIntent === query.userIntent) score += 2;
    if (query.objectionType && e.objectionType === query.objectionType) score += 2;
    score += Math.min(e.qualityScore, 1); // 0..1 tiebreaker
    return { e, score };
  });

  const ranked = scored
    .filter(({ score }) => score > 0.5)
    .sort((a, b) => b.score - a.score)
    .map(({ e }) => e);

  if (ranked.length >= min) return ranked.slice(0, Math.min(max, 8));
  // Fall back to best-quality approved examples to hit the minimum, if any exist.
  const rest = store
    .active()
    .filter((e) => !ranked.includes(e))
    .sort((a, b) => b.qualityScore - a.qualityScore);
  return [...ranked, ...rest].slice(0, Math.min(max, 8));
}

export function renderExamples(examples: VoiceExample[]): string {
  if (!examples.length) return "(no approved voice examples available yet)";
  return examples
    .map((e, i) => {
      const thread = e.thread
        .map((t) => `${t.role === "assistant" ? "Wesley" : "Person"}: ${t.text}`)
        .join("\n");
      return `Example ${i + 1} [situation: ${e.situation}; sentiment: ${e.sentiment}]\n${thread}\nWesley's reply: ${e.targetResponse}`;
    })
    .join("\n\n");
}
