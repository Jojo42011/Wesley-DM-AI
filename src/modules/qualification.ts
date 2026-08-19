import type { Lead } from "../domain/types.js";

/**
 * Lightweight deterministic qualification signal extraction — enriches
 * lead.qualification from what the person actually says. Purely additive;
 * never blocks the pipeline.
 */
export function extractQualificationSignals(
  lead: Lead,
  messageText: string,
): Record<string, unknown> {
  const q: Record<string, unknown> = { ...lead.qualification };
  const t = messageText.toLowerCase();

  if (!q.buy_or_sell) {
    if (
      /\b(buy|buying|purchase|first home|first house|looking for a (home|house|place))\b/.test(t) ||
      /\b(stop|done|tired of|sick of) (renting|leasing|paying rent)\b/.test(t)
    ) {
      q.buy_or_sell = "buy";
    } else if (/\b(sell|selling|list my|listing my)\b/.test(t)) {
      q.buy_or_sell = "sell";
    } else if (/\b(rent|renting|rental)\b/.test(t)) {
      q.buy_or_sell = "rent";
    }
  }

  if (!q.timeline) {
    if (/\b(asap|right away|immediately|this (week|month))\b/.test(t)) q.timeline = "immediate";
    else if (/\b(next year|in a year|eventually|someday|just looking|window shopping)\b/.test(t)) {
      q.timeline = "long_term";
    } else if (/\b(few months|this year|soon|next few)\b/.test(t)) q.timeline = "near_term";
  }

  const budget = t.match(/\$\s?(\d{2,4})\s?k\b|\$\s?([\d,]{5,9})\b/);
  if (budget && !q.budget_mention) {
    q.budget_mention = budget[0];
  }

  return q;
}
