import type { DmCampaignPolicy, Lead, Message, Sentiment } from "../domain/types.js";
import { isNearDuplicate } from "./similarity.js";

/**
 * Output validation and sanitization. Rejection reasons drive one retry
 * with RETROACTIVE_FIX, then a deterministic fallback — never an unlimited
 * model loop.
 */

export interface ValidationResult {
  ok: boolean;
  reply: string;
  reasons: string[];
  /** The conflicting prior Wesley line, when rejection was similarity. */
  conflictingLine?: string;
}

const ASSISTANT_PHRASES = [
  /\bas an ai\b/i,
  /\bour team\b/i,
  /\bi can help you with that\b/i,
  /\blanguage model\b/i,
  /\bvirtual assistant\b/i,
  /\bautomated (message|response)\b/i,
];

const ASKS_FOR_PHONE = /\b(what'?s|send|drop|share|give me|can i get)\b.{0,30}\b(number|phone|digits)\b/i;
const ASKS_FOR_EMAIL = /\b(what'?s|send|drop|share|give me|can i get)\b.{0,30}\b(e-?mail)\b/i;

function countSentences(text: string): number {
  return text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length;
}

export function validateReply(
  raw: string,
  policy: DmCampaignPolicy,
  lead: Lead,
  recentMessages: Message[],
  opts?: { sentiment?: Sentiment; closedTopics?: string[] },
): ValidationResult {
  const reasons: string[] = [];
  let reply = raw.trim();

  // Strip markdown / labels / wrapping quotes the model may add.
  reply = reply
    .replace(/^```[\s\S]*?\n|```$/g, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^["“](.+)["”]$/s, "$1")
    .replace(/^(Wesley|Reply|Response)\s*:\s*/i, "")
    .trim();

  if (!reply) {
    return { ok: false, reply: "", reasons: ["empty_reply"] };
  }

  // Character and sentence limits (enforce, don't just reject, when close).
  if (reply.length > policy.maxReplyCharacters * 1.5) {
    reasons.push("too_long");
  } else if (reply.length > policy.maxReplyCharacters) {
    // Soft-trim to the last sentence boundary within the limit.
    const cut = reply.slice(0, policy.maxReplyCharacters);
    const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
    if (lastStop > policy.maxReplyCharacters * 0.5) {
      reply = cut.slice(0, lastStop + 1).trim();
    } else {
      reasons.push("too_long");
    }
  }
  if (countSentences(reply) > policy.maxSentences + 1) {
    reasons.push("too_many_sentences");
  }

  // Similarity vs recent Wesley messages.
  const recentWesley = recentMessages.filter((m) => m.role === "assistant").slice(-5);
  for (const prev of recentWesley) {
    if (isNearDuplicate(reply, prev.text, 0.72)) {
      reasons.push("repeats_previous_outbound");
      return { ok: false, reply, reasons, conflictingLine: prev.text };
    }
  }

  // Prohibited claims.
  const lower = reply.toLowerCase();
  for (const claim of policy.prohibitedClaims) {
    if (lower.includes(claim.toLowerCase())) {
      reasons.push(`prohibited_claim:${claim}`);
    }
  }

  // Never ask for already-captured fields.
  if (lead.phone && ASKS_FOR_PHONE.test(reply)) reasons.push("asks_for_captured_phone");
  if (lead.email && ASKS_FOR_EMAIL.test(reply)) reasons.push("asks_for_captured_email");

  // Assistant-like phrases.
  for (const re of ASSISTANT_PHRASES) {
    if (re.test(reply)) reasons.push("assistant_phrase");
  }

  // Closed-topic questions.
  for (const topic of opts?.closedTopics ?? []) {
    const words = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    if (words.length && reply.includes("?")) {
      const hits = words.filter((w) => lower.includes(w)).length;
      if (hits / words.length >= 0.5) reasons.push(`reasks_closed_topic:${topic}`);
    }
  }

  // Sentiment appropriateness: no forced excitement at skeptical/resistant/upset people.
  const sentiment = opts?.sentiment;
  if (sentiment && ["skeptical", "resistant", "upset"].includes(sentiment)) {
    const exclamations = (reply.match(/!/g) ?? []).length;
    const hype = /\b(amazing|awesome|so excited|can'?t wait|incredible)\b/i.test(reply);
    if (exclamations >= 2 || hype) reasons.push("forced_enthusiasm");
  }

  return { ok: reasons.length === 0, reply, reasons };
}

export function buildRetroactiveFix(result: ValidationResult): string {
  const lines = [`RETROACTIVE_FIX: your previous draft was rejected (${result.reasons.join(", ")}).`];
  if (result.conflictingLine) {
    lines.push(
      `It was too similar to this earlier Wesley message: ${JSON.stringify(result.conflictingLine)}.`,
      "Write a different angle with a different sentence structure. Do not paraphrase the earlier line.",
    );
  }
  lines.push("Fix every issue and return the same JSON schema.");
  return lines.join("\n");
}
