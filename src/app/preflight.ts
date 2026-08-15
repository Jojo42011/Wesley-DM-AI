import type { Message, PreflightResult } from "../domain/types.js";
import {
  PREFLIGHT_JSON_SCHEMA,
  PreflightSchema,
  type LlmClient,
} from "../integrations/llm.js";
import { isNearDuplicate } from "./similarity.js";

/**
 * Turn preflight. Deterministic duplicate math is the AUTHORITY; the model
 * pass supplies sentiment/coaching only. If the model fails we still return
 * a usable result built from the deterministic signals.
 */

export function deterministicDuplicates(messages: Message[]): {
  userRepeated: boolean;
  wesleyRepeated: boolean;
} {
  const userMsgs = messages.filter((m) => m.role === "user").map((m) => m.text);
  const wesleyMsgs = messages.filter((m) => m.role === "assistant").map((m) => m.text);

  const latestUser = userMsgs[userMsgs.length - 1];
  const userRepeated =
    !!latestUser &&
    userMsgs.slice(0, -1).slice(-5).some((prev) => isNearDuplicate(latestUser, prev));

  const recentWesley = wesleyMsgs.slice(-4);
  let wesleyRepeated = false;
  for (let i = 0; i < recentWesley.length; i++) {
    for (let j = i + 1; j < recentWesley.length; j++) {
      if (isNearDuplicate(recentWesley[i]!, recentWesley[j]!)) wesleyRepeated = true;
    }
  }
  return { userRepeated, wesleyRepeated };
}

export async function runPreflight(
  llm: LlmClient,
  messages: Message[],
): Promise<PreflightResult> {
  const dup = deterministicDuplicates(messages);

  const defaults: PreflightResult = {
    ...dup,
    sentiment: "neutral",
    unansweredQuestions: [],
    closedTopics: [],
    nextObjective: "Respond helpfully to the latest message and move toward the campaign goal.",
    coachingNote: dup.wesleyRepeated
      ? "Do not reuse prior wording — take a fresh angle."
      : "",
    shouldReply: true,
    shouldEscalate: false,
  };

  // Single-turn conversations don't need a model preflight.
  const turns = messages.length;
  if (turns < 3) return defaults;

  const transcript = messages
    .slice(-16)
    .map((m) => `${m.role === "assistant" ? "Wesley" : "Person"}: ${m.text}`)
    .join("\n");

  const model = await llm.completeJson<PreflightResult>(
    {
      system:
        "You review a DM conversation before Wesley replies. Identify repeats, sentiment, unanswered questions, closed topics, the next objective, and whether to reply or escalate. Return JSON only.",
      user: transcript,
      maxTokens: 512,
    },
    PreflightSchema,
    PREFLIGHT_JSON_SCHEMA,
  );

  if (!model) return defaults;

  // Deterministic duplicate calculations override the model's opinion.
  return { ...model, userRepeated: dup.userRepeated, wesleyRepeated: dup.wesleyRepeated };
}
