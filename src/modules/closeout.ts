/**
 * Deterministic detectors for opt-out, acknowledgments, refusals,
 * agreements, closeouts, and "already sent it" claims. These run BEFORE
 * any model call — consent and closeout never depend on model cooperation.
 */

const OPT_OUT_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bdo\s*n[o']?t\s+(contact|message|text|dm)\s+me\b/i,
  /\bleave\s+me\s+alone\b/i,
  // "stop" only when aimed at the messaging itself — never "stop renting",
  // "stop by", "can't stop looking", etc.
  /\bstop\s+(messaging|texting|dm+ing|contacting|following)\b/i,
  /\bremove\s+me\b/i,
  /\bopt\s*out\b/i,
];

export function isOptOut(text: string): boolean {
  const t = text.trim();
  // Bare "stop" (the universal opt-out keyword) on its own message.
  if (/^stop\.?!?$/i.test(t)) return true;
  return OPT_OUT_PATTERNS.some((re) => re.test(t));
}

const ACK_PATTERNS = [
  /^(ok(ay)?|k+|kk)\.?!?$/i,
  /^(thanks?|thank you|thx|ty|tysm)\.?!?\s*!*$/i,
  /^(sounds good|perfect|great|awesome|cool|got it|will do|bet|👍)\.?!?$/i,
  /^(thanks?|thank you)[,!.\s]+(so much|a lot|man|bro)?\.?!?$/i,
];

export function isSimpleAcknowledgment(text: string): boolean {
  const t = text.trim();
  if (t.length > 40) return false;
  return ACK_PATTERNS.some((re) => re.test(t));
}

const REFUSAL_PATTERNS = [
  /\b(no thanks|no thank you|not interested|i'?m good|nah|no way)\b/i,
  /\b(don'?t|not) (want|wanna|going) to (give|share|send)\b.*\b(number|phone|email)\b/i,
  /\bnot (giving|sharing|sending) (you )?(my )?(number|phone|email)\b/i,
  /\brather not\b/i,
  /\bi'?d rather keep\b/i,
  /\bprefer not\b/i,
];

export function isCtaRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

const AGREEMENT_PATTERNS = [
  /^(yes|yeah|yep|yup|sure|ok(ay)? sure|sounds good|let'?s do it|absolutely|definitely|down|i'?m in)\b/i,
  /\b(that works|works for me|let'?s go)\b/i,
];

export function isAgreement(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  return AGREEMENT_PATTERNS.some((re) => re.test(t));
}

const ALREADY_SENT_PATTERNS = [
  /\b(i )?(already|just) (sent|gave|shared|texted)( it| that| you)?( to you)?\b/i,
  /\bsent (it|that|my (number|email)) (already|earlier|before)\b/i,
  /\byou (already )?have (my|it)\b/i,
];

export function saysAlreadySent(text: string): boolean {
  return ALREADY_SENT_PATTERNS.some((re) => re.test(text));
}

const CLOSEOUT_PATTERNS = [
  /\b(bye|goodbye|later|talk (to you )?(later|soon)|have a good (day|night|one))\b/i,
  /\btake care\b/i,
];

export function isCloseout(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  return CLOSEOUT_PATTERNS.some((re) => re.test(t));
}

/** Direct question detector (deterministic first pass). */
export function isDirectQuestion(text: string): boolean {
  const t = text.trim();
  if (t.includes("?")) return true;
  return /^(how|what|when|where|why|who|can you|do you|does|is it|are you|will you|should i)\b/i.test(t);
}
