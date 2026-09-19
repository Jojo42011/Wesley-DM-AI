/**
 * The TikTok comment agent: read a comment, decide whether Wesley would answer
 * it, and if so post a public reply that earns a DM.
 *
 * WHY A PUBLIC REPLY AND NOT A DM. TikTok has no comment-to-DM: Instagram and
 * Facebook are the only platforms exposing private-reply-to-comment, and TikTok
 * forbids a business opening a DM thread at all. So the only legal path is to
 * answer in public and let the person open the thread themselves — which is also
 * what makes the 48-hour reply window the DM agent lives inside legitimate. The
 * person who does not DM was never qualified, and the VA can chase them by hand
 * from `getFollowUpQueue`.
 *
 * WHAT THIS IS NOT. It is not a blanket auto-responder. One video in Wesley's
 * account has 163 comments; blasting a blunt "DM me" under all of them in an
 * afternoon is the textbook spam signature, Zernio's own docs note TikTok's API
 * moderation is stricter than the app, and the account whose reach IS the lead
 * flow is the thing that would pay for it. Four independent limits keep that
 * from happening, and they live in `decide()` below rather than in a prompt,
 * because a model cannot be trusted to rate-limit itself. The invite itself must
 * also stay warm ("for some reason I can't DM you… mind shooting me a quick
 * one?") rather than an order.
 *
 * WHY THE CLASSIFIER IS A MODEL AND NOT A KEYWORD LIST. Wesley's own comments
 * settle this. Two of the top comments on the acreage listing are "Oak" and
 * "OAK" — a call-to-action keyword from the video, which makes them among the
 * hottest leads in the thread, and any keyword list files them as noise.
 * Meanwhile "Why promote properties and not put address, location?" contains
 * two intent words and is a complaint. The existing `keyword lists`
 * classifier is a keyword list for exactly this reason, and it is why this is a
 * new agent rather than an edit to that one.
 */
import Anthropic from "@anthropic-ai/sdk";

import {
  authorAlreadyAnsweredOnPost,
  hasActedOnComment,
  isOurOwnPostedComment,
  lastReplyPostedAt,
  recordCommentAction,
  repliesPostedSince,
  type CommentDecision,
} from "../../persistence/commentAgentStore.js";
import {
  postCommentReply,
  readBackComment,
  type ZernioInboundComment,
} from "../../integrations/zernio/comments.js";
import { createLogger, preview } from "../../observability/logger.js";


function logComment(event: "comment_agent_replied" | "comment_agent_post_failed" | "comment_agent_outcome", fields: Record<string, unknown>): void {
  createLogger({ transport: "zernio_comment" }).log(event, fields);
}


/** The five ways a comment can read. Only three of them earn a reply. */
export type CommentBucket = "high_intent" | "casual" | "social" | "frustrated" | "skip";

const REPLY_BUCKETS = new Set<CommentBucket>(["high_intent", "casual", "social", "frustrated"]);

export interface CommentClassification {
  bucket: CommentBucket;
  reply: string | null;
  reason: string;
}

/* ── limits ────────────────────────────────────────────────────────────────
   Deliberately environment-tunable and deliberately conservative by default.
   These are the difference between an agent that works the funnel and one that
   gets the account's reach throttled, and they are enforced in code against a
   durable ledger — not counted in memory, which a deploy would reset to zero
   in the middle of an afternoon. */
function maxPerHour(): number {
  return Number(process.env.COMMENT_AGENT_MAX_PER_HOUR ?? 12);
}
function maxPerDay(): number {
  return Number(process.env.COMMENT_AGENT_MAX_PER_DAY ?? 60);
}
function minSpacingSeconds(): number {
  return Number(process.env.COMMENT_AGENT_MIN_SPACING_SEC ?? 25);
}
/** Answering a three-week-old comment reads as a bot sweeping the backlog. */
function maxCommentAgeHours(): number {
  return Number(process.env.COMMENT_AGENT_MAX_COMMENT_AGE_HOURS ?? 48);
}
/** The kill switch. Set to "false" to stop every public post immediately. */
export function isCommentAgentEnabled(): boolean {
  const v = process.env.COMMENT_AGENT_ENABLED?.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return true;
}

const COMMENT_AGENT_SYSTEM = `
You are Wesley Dulin replying to a comment on your own TikTok, in public, under a
video of a Texas home you toured. You are a real agent, not a brand account.

Your job is to classify the comment and, when it deserves it, write the reply.

BUCKETS (pick exactly one):
- "high_intent": they are asking for something a buyer asks for. Price, cost, info,
  location, city, address, availability, beds, baths, HOA, taxes, square footage,
  financing, a tour, "more details", "is it still available". ALSO a bare keyword
  that is obviously the video's call to action (a single word like "Oak", "Info",
  a place name, or a word repeated by many commenters). Those are the hottest
  leads in the thread, never noise.
- "casual": they like the home or a feature of it but did not ask for anything.
  "That pool is nice", "So much character", "I love this one", a fire emoji.
- "social": on-topic conversation that is not about buying. Pointing out a detail,
  correcting you, asking something general about the market, tagging a friend with
  a remark. Reply like a person; do NOT pitch.
- "frustrated": they are annoyed, specifically about information being withheld.
  "why can't you just post the price", "why is it so hard to post the info",
  "clickbait", "stop making people ask".
- "skip": anything you should not answer. Spam, bots, promotion of something else,
  insults, off-topic noise, a comment that is only a tag of another user with no
  remark, anything already clearly answered in the thread, or your own words.

HOW THE DM INVITE MUST SOUND (this is the whole point of the public reply):
TikTok will not let a business open a DM, so you cannot message them first. That
is real, and you lean on it warmly. Never order them to DM you. Never sound armed
or blunt. Soft, light hearted, respectful, so they want to do it.

BAD (never write these shapes):
- "DM me"
- "Send me a DM"
- "I can't DM you, send me a DM"
- "Shoot me a DM" as a standalone command

GOOD (vary the words every time, keep this warmth):
- "Hey for some reason I can't send you a DM from my account. Would it be okay if you shot me a quick one?"
- "For some reason I can't DM you from here. Do you mind shooting me a quick text?"
- "Hey I can't send you a DM from my side for some reason. Mind if you shoot me one real quick?"

HOW TO REPLY, by bucket:
- high_intent: acknowledge in a couple of words, then the warm DM invite above,
  because that is where the full breakdown goes. Vary the wording every time.
- casual: match their energy, be warm and a little funny if it fits, then the same
  warm DM invite. Example shape: "Nice enough to look into more? For some reason I
  can't send you a DM from my account, mind shooting me a quick one?" Never force
  a hard pitch. Do answer these, do not skip them.
- social: just be a person. Answer or acknowledge. You may use the warm DM invite
  only if it is genuinely natural. It is fine not to.
- frustrated: do not get defensive and do not pitch. Acknowledge the runaround in
  a few words, give them the CITY, and use the warm DM invite once, gently.
- skip: reply MUST be null.

WHAT YOU ACTUALLY KNOW, and it is almost nothing:
You are given the comment and, sometimes, the video's caption. That is all. The
city is the only fact about the home you may state. You do NOT know the price,
the price range, whether it is still available, whether it is under contract, the
taxes, the HOA, the lot size, or anything else unless it is written verbatim in
the caption you were given. When you do not know, that is exactly what the DM is
for. The warm invite ("for some reason I can't send a DM from my account, mind
shooting me a quick one?") is always available to you and is never wrong.

HARD RULES, these are not style preferences:
- NEVER state a price. Not an exact figure, not a range, and not a band in words.
  "mid 500s", "high 400s", "around 500k", "starts in the 600s" are all forbidden.
  This is a public comment attached to a real listing forever, and a number you
  were not given is a number you invented.
- NEVER claim the home is still available, still on the market, sold, pending or
  under contract. You do not know. Offering to check over DM with the warm invite
  is the honest answer and works just as well.
- NEVER give the street address, the exact cross streets, the neighbourhood, the
  subdivision, or the builder/developer name. You may say the city.
- NEVER state any other spec you were not given (beds, baths, square footage,
  acreage, year built, taxes, HOA). Invite the DM instead.
- NEVER invent a fact about the home. If you do not know it, invite the DM.
- NEVER use a hyphen, an em dash, or an en dash anywhere in the reply. Not as a
  pause, not in a compound word, not at all. Commas, periods, and question marks
  only. Write "do you mind" not clipped dash phrases.
- NEVER open with "Great question", "Of course", "I'd be happy to", "That's a
  great point", or "Absolutely" as filler.
- Do not start with an upbeat word when the comment is negative or frustrated.
- ONE sentence is ideal. Two short ones is the maximum. This is a comment, not
  a DM, and length reads as automated.
- Do not @ mention them, do not sign your name, do not add hashtags.
- At most one emoji, and only where it genuinely fits. Usually none.

Return ONLY minified JSON, no prose and no code fence:
{"bucket":"high_intent","reply":"...","reason":"asked for price"}
Use null for reply when the bucket is "skip".
`.trim();

function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function parseClassificationJson(raw: string): CommentClassification | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const bucket = String(o.bucket ?? "") as CommentBucket;
    if (!["high_intent", "casual", "social", "frustrated", "skip"].includes(bucket)) return null;
    const reply = typeof o.reply === "string" && o.reply.trim() ? o.reply.trim() : null;
    return { bucket, reply, reason: String(o.reason ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

/**
 * Last line of defence on the copy itself.
 *
 * The prompt forbids these, but a model that slips a dollar figure into a public
 * comment under a real listing has done something we cannot take back, so the
 * ban is also enforced here. Returns null when the draft must not be posted.
 */
export function vetCommentReply(reply: string | null): { ok: boolean; text: string | null; why?: string } {
  if (!reply) return { ok: false, text: null, why: "no draft" };
  let t = reply.replace(/\s+/g, " ").trim();
  if (!t) return { ok: false, text: null, why: "empty after normalise" };

  /* A dollar amount or a 6-digit number is a price. Never in public. */
  if (/\$\s?\d/.test(t) || /\b\d{3},\d{3}\b/.test(t) || /\b[4-9]\d{5}\b/.test(t)) {
    return { ok: false, text: null, why: "contains a specific price" };
  }
  /* A price BAND is the same invention wearing softer words, and the live
     dry-run proved the model reaches for it: asked "why can't you just post the
     price", it answered "Texas, mid 500s" for a house whose price it was
     never given. The band came from Wesley's DM prompts, where it is a trained
     figure for a different listing entirely. On a public comment under a real
     home, that is a made-up price. */
  if (/\b(mid|high|low|upper|around|about|roughly|starting|starts)\s*(at\s*)?(the\s*)?[1-9]\d{2}s?\b/i.test(t)
      || /\b\d{2,4}\s?k\b/i.test(t)
      || /\b[1-9]\d{2}s\b/.test(t)) {
    return { ok: false, text: null, why: "contains a price band we were never given" };
  }
  /* Asserting market status we do not know. Offering to check over DM is allowed;
     "yep, still on the market" is a claim. */
  if (/\b(still (available|on the market|up for sale)|already (sold|pending)|under contract|it'?s sold)\b/i.test(t)
      && !/\b(check|find out|confirm|look)\b/i.test(t)) {
    return { ok: false, text: null, why: "asserts availability we do not know" };
  }
  /* A street address in a public reply. */
  if (/\b\d{3,6}\s+[A-Z][a-z]+\s+(St|Street|Rd|Road|Dr|Drive|Ln|Lane|Ave|Avenue|Ct|Court|Blvd|Way|Trail|Trl)\b/.test(t)) {
    return { ok: false, text: null, why: "contains a street address" };
  }
  if (t.length > 220) return { ok: false, text: null, why: "too long for a comment" };

  /* Wesley's formatting rule, enforced not hoped for: no hyphen, em dash, or en
     dash ever reaches a public comment. Pause dashes become commas; any leftover
     hyphen (compound words included) becomes a space. Rejecting a good reply
     over punctuation would cost a lead, so we repair rather than refuse. "Dm"
     is a typo the model produced live; DM is how a person writes it. */
  t = t.replace(/\s*[‐‑‒–—―−]\s*/g, ", ");
  t = t.replace(/\s+-\s+/g, ", ");
  t = t.replace(/-/g, " ");
  t = t.replace(/\s+,/g, ",").replace(/,\s*,+/g, ",").replace(/\s+/g, " ").trim();
  t = t.replace(/\bDm\b/g, "DM").replace(/\bdm\b/g, "DM");
  if (/[‐‑‒–—―−-]/.test(t)) {
    return { ok: false, text: null, why: "still contains a hyphen or dash after repair" };
  }
  return { ok: true, text: t };
}

/**
 * Classify one comment and draft its reply. One model call, because the bucket
 * and the wording are the same judgement and splitting them invites a reply that
 * does not match its own classification.
 */
export async function classifyAndDraft(input: {
  commentText: string;
  authorUsername: string | null;
  postCaption?: string | null;
}): Promise<CommentClassification | null> {
  const client = getClient();
  if (!client) return null;

  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5";
  const ctx = [
    input.postCaption ? `VIDEO CAPTION: ${input.postCaption}` : null,
    `COMMENT: ${input.commentText}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await client.messages.create({
      model,
      max_tokens: 250,
      system: COMMENT_AGENT_SYSTEM,
      messages: [{ role: "user", content: ctx }],
    });
    const block = res.content[0];
    if (!block || block.type !== "text") return null;
    return parseClassificationJson(block.text);
  } catch (err) {
    console.error("[commentAgent] classification failed:", err);
    return null;
  }
}

export interface CommentAgentOutcome {
  decision: CommentDecision;
  bucket: CommentBucket | null;
  reply: string | null;
  reason: string;
}

function record(
  evt: ZernioInboundComment,
  decision: CommentDecision,
  reason: string,
  bucket: CommentBucket | null = null,
  replyText: string | null = null,
  postedCommentId: string | null = null,
  username: string | null = null,
): CommentAgentOutcome {
  recordCommentAction({
    commentId: evt.commentId,
    platform: evt.platform,
    platformPostId: evt.platformPostId,
    authorId: evt.authorId,
    authorUsername: username ?? evt.authorUsername,
    commentText: evt.text || null,
    bucket,
    decision,
    reason,
    replyText,
    postedCommentId,
    commentCreatedAt: evt.createdAt,
  });
  return { decision, bucket, reply: replyText, reason };
}

/**
 * The whole decision, in the order that costs least.
 *
 * Every cheap refusal runs before the model call, and every guard that protects
 * the account runs before the post. The sequence is the design: a duplicate is
 * rejected by the database before we spend a token on it, and the rate limit is
 * checked before we generate a reply we would then have to throw away.
 */
export async function handleInboundComment(
  evt: ZernioInboundComment,
  accountId: string,
  opts?: {
    postCaption?: string | null;
    /**
     * Substitute classifier. The one seam in this file: classification is the
     * only step that needs a live Anthropic key, and the guard sequence around
     * it is the part that must be provable. Production never passes this.
     */
    classify?: typeof classifyAndDraft;
  },
): Promise<CommentAgentOutcome> {
  /* 1. Already decided. Zernio replays at-least-once; the ledger is the truth. */
  if (hasActedOnComment(evt.commentId)) {
    return { decision: "skipped_duplicate", bucket: null, reply: null, reason: "already acted" };
  }

  /* 2. LOOP GUARD, first of two: is this a reply WE posted? TikTok's comment
        webhook has no owner flag, so without this the agent answers itself in
        public, forever. Not recorded — writing a row keyed to our own comment id
        would pollute the ledger the guard reads. */
  if (isOurOwnPostedComment(evt.commentId)) {
    return {
      decision: "skipped_own_comment",
      bucket: null,
      reply: null,
      reason: "this is our own posted reply coming back as an event",
    };
  }

  if (!isCommentAgentEnabled()) {
    return record(evt, "skipped_disabled", "COMMENT_AGENT_ENABLED is false");
  }

  /* 3. Age. Sweeping a backlog is what a bot looks like. */
  if (evt.createdAt) {
    const ageH = (Date.now() - new Date(evt.createdAt).getTime()) / 3600_000;
    if (Number.isFinite(ageH) && ageH > maxCommentAgeHours()) {
      return record(evt, "skipped_too_old", `comment is ${Math.round(ageH)}h old`);
    }
  }

  /* 4. One reply per person per video. */
  if (authorAlreadyAnsweredOnPost(evt.authorId, evt.platformPostId)) {
    return record(evt, "skipped_author_already_answered", "author already answered on this post");
  }

  if (!evt.text.trim()) {
    return record(evt, "skipped_bucket", "comment has no text to read");
  }

  /* 5. Pacing, before the model call so a throttled turn costs nothing. */
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  if (repliesPostedSince(hourAgo) >= maxPerHour()) {
    return record(evt, "skipped_rate_limit", `hourly cap ${maxPerHour()} reached`);
  }
  if (repliesPostedSince(dayAgo) >= maxPerDay()) {
    return record(evt, "skipped_rate_limit", `daily cap ${maxPerDay()} reached`);
  }
  const last = lastReplyPostedAt();
  if (last) {
    const gapS = (Date.now() - new Date(last).getTime()) / 1000;
    if (Number.isFinite(gapS) && gapS < minSpacingSeconds()) {
      return record(evt, "skipped_rate_limit", `only ${Math.round(gapS)}s since the last reply`);
    }
  }

  /* 6. LOOP GUARD, second of two, plus the username the webhook withheld.
        Fails CLOSED: a comment we cannot read back is a comment we do not
        answer. One missed lead is cheaper than a public loop. */
  const back = await readBackComment(evt.platformPostId, evt.commentId, accountId);
  if (!back.found) {
    return record(evt, "skipped_cannot_reply", "could not read the comment back from the post");
  }
  if (back.isOwner) {
    return record(evt, "skipped_own_comment", "comment is authored by the connected account");
  }
  if (!back.canReply || back.isHidden) {
    return record(evt, "skipped_cannot_reply", "platform will not accept a reply here");
  }
  const username = back.username ?? evt.authorUsername;

  /* 7. Classify and draft. */
  const drafted = await (opts?.classify ?? classifyAndDraft)({
    commentText: back.text ?? evt.text,
    authorUsername: username,
    postCaption: opts?.postCaption ?? null,
  });
  if (!drafted) {
    /* No API key, or the model failed. Fail SILENT, never fall back to a canned
       "DM me" — a template posted under every comment is the spam pattern this
       agent exists to avoid. */
    return record(evt, "failed", "classification unavailable", null, null, null, username);
  }
  if (!REPLY_BUCKETS.has(drafted.bucket)) {
    return record(evt, "skipped_bucket", drafted.reason || "bucket is skip", drafted.bucket, null, null, username);
  }

  const vetted = vetCommentReply(drafted.reply);
  if (!vetted.ok || !vetted.text) {
    return record(evt, "failed", `draft rejected: ${vetted.why}`, drafted.bucket, null, null, username);
  }

  /* 8. Post it. */
  const posted = await postCommentReply({
    platformPostId: evt.platformPostId,
    commentId: evt.commentId,
    accountId,
    message: vetted.text,
    idempotencyKey: `zcomment:${evt.commentId}`,
  });

  if (!posted.success) {
    logComment("comment_agent_post_failed", {
      comment_id: evt.commentId,
      post_id: evt.platformPostId,
      status: posted.status,
      error: posted.error ?? null,
    });
    return record(
      evt,
      "failed",
      `post failed (HTTP ${posted.status}): ${posted.error ?? "unknown"}`,
      drafted.bucket,
      vetted.text,
      null,
      username,
    );
  }

  logComment("comment_agent_replied", {
    comment_id: evt.commentId,
    post_id: evt.platformPostId,
    author: username ?? evt.authorId.slice(0, 8),
    bucket: drafted.bucket,
    comment_preview: preview(back.text ?? evt.text, 90),
    reply_preview: preview(vetted.text, 120),
    posted_comment_id: posted.postedCommentId ?? null,
  });

  return record(
    evt,
    "replied",
    drafted.reason || "replied",
    drafted.bucket,
    vetted.text,
    posted.postedCommentId ?? null,
    username,
  );
}
