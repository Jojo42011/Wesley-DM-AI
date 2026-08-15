import type { DmCampaignPolicy, FallbackKind, Message } from "../domain/types.js";
import { isNearDuplicate } from "./similarity.js";

/**
 * Deterministic fallback selection. Considers recent outbound messages so a
 * fallback never repeats the previous response.
 */
export function selectFallback(
  policy: DmCampaignPolicy,
  kind: FallbackKind,
  recentMessages: Message[],
): string {
  const options = policy.fallbackResponses[kind] ?? [];
  const recentOutbound = recentMessages
    .filter((m) => m.role === "assistant")
    .slice(-4)
    .map((m) => m.text);

  for (const option of options) {
    const repeats = recentOutbound.some((prev) => isNearDuplicate(option, prev, 0.7));
    if (!repeats) return option;
  }
  // All options recently used — pick the least recently used one.
  return options[0] ?? "Got it — let me get back to you on that shortly.";
}
