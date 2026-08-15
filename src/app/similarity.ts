/**
 * Deterministic text similarity used as the AUTHORITY for duplicate
 * detection (the model's near-duplicate opinion is only coaching).
 */

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token-level Jaccard similarity on normalized text. 0..1 */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Character-level Sørensen–Dice on bigrams — catches paraphrase-y overlap. */
export function diceBigramSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let overlap = 0;
  let total = 0;
  for (const [, n] of ga) total += n;
  for (const [, n] of gb) total += n;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / total;
}

/** Combined similarity — the max of the two measures. */
export function similarity(a: string, b: string): number {
  return Math.max(jaccardSimilarity(a, b), diceBigramSimilarity(a, b));
}

export function isNearDuplicate(a: string, b: string, threshold = 0.75): boolean {
  return similarity(a, b) >= threshold;
}
