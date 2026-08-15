import type { DmCampaignPolicy, IntentGateResult } from "../domain/types.js";
import {
  INTENT_GATE_JSON_SCHEMA,
  IntentGateSchema,
  type LlmClient,
} from "../integrations/llm.js";

/**
 * New-contact intent gate. Runs ONLY for brand-new leads with no manual
 * opener (a person replying to a seeded Wesley message is clearly engaged).
 *
 * Deterministic exclusions first; a low-cost classifier only for ambiguity.
 * Low confidence never discards a potentially real person.
 */

export type GateDecision =
  | { action: "accept"; reason: string }
  | { action: "clarify"; reason: string }
  | { action: "reject"; reason: string }
  | { action: "escalate"; reason: string };

const SPAM_PATTERNS = [
  /\b(follow ?4 ?follow|f4f|l4l|sub4sub)\b/i,
  /\b(promote|boost) your (page|account|content)\b/i,
  /\bcollab\b.*\bbrand\b/i,
  /\bcrypto\b.*\b(invest|profit|guaranteed)\b/i,
  /\bforex\b/i,
  /\bwe can grow your\b/i,
  /\bcheck out my (page|profile|link)\b/i,
];

const DENIAL_PATTERNS = [
  /\bi (never|didn'?t) (message|messaged|contact|dm)/i,
  /\bwrong person\b/i,
  /\bwho is this\b.*\bstop\b/i,
];

const UNSAFE_PATTERNS = [/\bkill\b/i, /\bthreat/i, /\bsuicid/i];

export function deterministicGate(message: string): GateDecision | null {
  const t = message.trim();
  if (!t) return { action: "reject", reason: "empty_message" };
  if (UNSAFE_PATTERNS.some((re) => re.test(t))) {
    return { action: "escalate", reason: "unsafe_content" };
  }
  if (DENIAL_PATTERNS.some((re) => re.test(t))) {
    return { action: "reject", reason: "denies_contact" };
  }
  if (SPAM_PATTERNS.some((re) => re.test(t))) {
    return { action: "reject", reason: "spam_or_solicitation" };
  }
  return null; // ambiguous → classifier
}

export async function runIntentGate(
  llm: LlmClient,
  policy: DmCampaignPolicy,
  message: string,
): Promise<GateDecision> {
  const deterministic = deterministicGate(message);
  if (deterministic) return deterministic;

  const result = await llm.completeJson<IntentGateResult>(
    {
      system:
        `You classify whether an inbound TikTok DM belongs to this campaign.\n` +
        `CAMPAIGN OBJECTIVE: ${policy.objective}\n` +
        `Return JSON only.`,
      user: `Inbound message: ${JSON.stringify(message)}\nIs this person plausibly interested in the campaign topic?`,
      maxTokens: 256,
    },
    IntentGateSchema,
    INTENT_GATE_JSON_SCHEMA,
  );

  if (!result) {
    // Classifier failed — do not discard a potentially real person.
    return { action: "clarify", reason: "classifier_unavailable" };
  }
  if (result.interested && result.confidence >= 0.6) {
    return { action: "accept", reason: result.reason };
  }
  if (!result.interested && result.confidence >= 0.85) {
    return { action: "reject", reason: result.reason };
  }
  return { action: "clarify", reason: `low_confidence:${result.reason}` };
}
