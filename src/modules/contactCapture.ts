import { parsePhoneNumberFromString } from "libphonenumber-js";
import type { Message } from "../domain/types.js";

/**
 * Deterministic contact extraction — code, not model prose, is the
 * authority for captured fields.
 */

export interface PhoneExtraction {
  e164: string;
  sourceMessageId: string | null;
  confidence: number;
}

export interface EmailExtraction {
  email: string;
  sourceMessageId: string | null;
  confidence: number;
}

/** Reject repeated-digit / sequential junk like 1111111111 or 1234567890. */
function isJunkNumber(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  if ("1234567890".includes(digits) || "0987654321".includes(digits)) return true;
  const unique = new Set(digits.split(""));
  return unique.size <= 2;
}

/**
 * Heuristics to avoid treating unrelated numeric values as phone numbers:
 * prices ($450,000), years, square footage, percentages, plain counts.
 */
function looksLikeNonPhoneContext(text: string, match: string): boolean {
  const idx = text.indexOf(match);
  const before = text.slice(Math.max(0, idx - 12), idx);
  const after = text.slice(idx + match.length, idx + match.length + 14);
  if (/[$€£]\s*$/.test(before)) return true;
  if (/^\s*(k|m|sq\s*ft|sqft|acres?|%|percent|dollars?|bucks|grand)\b/i.test(after)) return true;
  const digits = match.replace(/\D/g, "");
  if (digits.length === 4 && /^(19|20)\d{2}$/.test(digits)) return true; // year
  return false;
}

const PHONE_CANDIDATE = /(\+?\d[\d\s().-]{6,18}\d)/g;

export function extractPhone(
  messages: Message[],
  defaultRegion = "US",
): PhoneExtraction | null {
  // Search recent USER messages only, newest first.
  const recent = messages.filter((m) => m.role === "user").slice(-6).reverse();
  for (const msg of recent) {
    const candidates = msg.text.match(PHONE_CANDIDATE) ?? [];
    for (const cand of candidates) {
      const digits = cand.replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) continue;
      if (isJunkNumber(digits)) continue;
      if (looksLikeNonPhoneContext(msg.text, cand)) continue;
      const parsed = parsePhoneNumberFromString(
        cand,
        defaultRegion as Parameters<typeof parsePhoneNumberFromString>[1],
      );
      if (parsed?.isValid()) {
        return {
          e164: parsed.number,
          sourceMessageId: msg.providerMessageId ?? msg.id,
          confidence: candidates.length === 1 ? 0.95 : 0.85,
        };
      }
    }
  }
  return null;
}

// Conservative email pattern (no exotic quoting), then normalization.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

export function extractEmail(messages: Message[]): EmailExtraction | null {
  const recent = messages.filter((m) => m.role === "user").slice(-6).reverse();
  for (const msg of recent) {
    const found = msg.text.match(EMAIL_RE);
    if (found && found[0]) {
      return {
        email: found[0].toLowerCase(),
        sourceMessageId: msg.providerMessageId ?? msg.id,
        confidence: 0.95,
      };
    }
  }
  return null;
}
