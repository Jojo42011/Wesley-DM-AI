/**
 * Zernio comment surface — reading TikTok comments and posting public replies.
 *
 * Separate from `dm.ts` because the two carry different risk. A DM reply is
 * seen by one person who asked for it; a comment reply is permanently attached
 * to Wesley's video. The guards that matter here are about not embarrassing
 * the account in public.
 *
 * TikTok's `comment.received` payload omits the owner flag, so our own replies
 * would loop without a REST read-back (`GET /inbox/comments/{postId}`) that
 * returns `from.isOwner` and `canReply`.
 *
 * COMMENT-TO-DM IS NOT AVAILABLE ON TIKTOK. The agent posts a PUBLIC reply
 * asking the person to DM; that DM opens the 48-hour window the DM agent uses.
 */
import { randomUUID } from "node:crypto";

const ZERNIO_API_BASE = process.env.ZERNIO_API_BASE?.trim() || "https://zernio.com/api/v1";

function apiKey(): string {
  return process.env.ZERNIO_DM_API_KEY?.trim() ?? "";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

async function zernioFetch(
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(`${ZERNIO_API_BASE}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* Non-JSON error bodies exist; raw text is kept for the caller's log. */
  }
  return { ok: res.ok, status: res.status, json, text };
}

export interface ZernioInboundComment {
  eventId: string;
  commentId: string;
  platformPostId: string;
  postId: string | null;
  platform: string;
  text: string;
  authorId: string;
  authorUsername: string | null;
  createdAt: string | null;
  isReply: boolean;
  parentCommentId: string | null;
  /** Present when Zernio includes account on the webhook; may be null. */
  accountId: string | null;
}

export function parseZernioInboundComment(body: unknown): ZernioInboundComment | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.event !== "comment.received") return null;

  const c = (b.comment ?? {}) as Record<string, unknown>;
  const author = (c.author ?? {}) as Record<string, unknown>;
  const account = (b.account ?? {}) as Record<string, unknown>;

  const commentId = str(c.id);
  const platformPostId = str(c.platformPostId);
  const authorId = str(author.id);
  if (!commentId || !platformPostId || !authorId) return null;

  return {
    eventId: str(b.id) ?? `${commentId}:${randomUUID()}`,
    commentId,
    platformPostId,
    postId: str(c.postId),
    platform: str(c.platform) ?? "tiktok",
    text: str(c.text) ?? "",
    authorId,
    authorUsername: str(author.username),
    createdAt: str(c.createdAt),
    isReply: c.isReply === true,
    parentCommentId: str(c.parentCommentId),
    accountId: str(account.accountId) ?? str(account.id),
  };
}

export interface CommentReadBack {
  found: boolean;
  isOwner: boolean;
  canReply: boolean;
  username: string | null;
  text: string | null;
  isHidden: boolean;
  replyCount: number;
}

export async function readBackComment(
  platformPostId: string,
  commentId: string,
  accountId: string,
): Promise<CommentReadBack> {
  const miss: CommentReadBack = {
    found: false,
    isOwner: false,
    canReply: false,
    username: null,
    text: null,
    isHidden: false,
    replyCount: 0,
  };
  if (!apiKey()) return miss;
  try {
    const qs = new URLSearchParams({ accountId, limit: "100" });
    const r = await zernioFetch(
      `/inbox/comments/${encodeURIComponent(platformPostId)}?${qs}`,
      { method: "GET" },
    );
    if (!r.ok) return miss;
    const payload = r.json as { comments?: unknown; data?: unknown } | null;
    const list = (
      Array.isArray(payload?.comments) ? payload.comments : Array.isArray(payload?.data) ? payload.data : []
    ) as Record<string, unknown>[];

    const flat: Record<string, unknown>[] = [];
    for (const top of list) {
      flat.push(top);
      const replies = Array.isArray(top.replies) ? (top.replies as Record<string, unknown>[]) : [];
      for (const rep of replies) flat.push(rep);
    }

    const hit = flat.find((m) => str(m.id) === commentId);
    if (!hit) return miss;
    const from = (hit.from ?? {}) as Record<string, unknown>;
    return {
      found: true,
      isOwner: from.isOwner === true,
      canReply: hit.canReply !== false,
      username: str(from.username) ?? str(from.name),
      text: str(hit.message) ?? str(hit.text),
      isHidden: hit.isHidden === true,
      replyCount: typeof hit.replyCount === "number" ? hit.replyCount : 0,
    };
  } catch {
    return miss;
  }
}

export interface PostCommentReplyResult {
  success: boolean;
  status: number;
  postedCommentId?: string;
  error?: string;
}

export async function postCommentReply(input: {
  platformPostId: string;
  commentId: string;
  accountId: string;
  message: string;
  idempotencyKey?: string;
}): Promise<PostCommentReplyResult> {
  if (!apiKey()) {
    return { success: false, status: 0, error: "ZERNIO_DM_API_KEY is not set" };
  }
  const message = input.message?.trim();
  if (!message) return { success: false, status: 0, error: "Empty reply, nothing posted" };

  try {
    const r = await zernioFetch(`/inbox/comments/${encodeURIComponent(input.platformPostId)}`, {
      method: "POST",
      headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {},
      body: JSON.stringify({
        accountId: input.accountId,
        message,
        commentId: input.commentId,
      }),
    });
    if (!r.ok) {
      return { success: false, status: r.status, error: r.text.slice(0, 400) || `HTTP ${r.status}` };
    }
    const d = (r.json ?? {}) as { data?: { commentId?: unknown }; commentId?: unknown };
    return {
      success: true,
      status: r.status,
      postedCommentId: str(d.data?.commentId) ?? str(d.commentId) ?? undefined,
    };
  } catch (err) {
    return {
      success: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
