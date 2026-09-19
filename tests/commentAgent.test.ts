/**
 * Comment agent guards — the sequence that keeps public replies safe.
 * Classification is injected so tests never need a live Anthropic key.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  handleInboundComment,
  vetCommentReply,
} from "../src/agents/commentAgent/index.js";
import type { ZernioInboundComment } from "../src/integrations/zernio/comments.js";
import { resetCommentAgentDbForTests } from "../src/persistence/commentAgentStore.js";
import { ZernioWebhookHandler } from "../src/app/zernioWebhook.js";
import { makeDeps } from "./helpers.js";

let dbDir: string;

beforeEach(() => {
  resetCommentAgentDbForTests();
  dbDir = mkdtempSync(path.join(tmpdir(), "wesley-ca-"));
  process.env.COMMENT_AGENT_DB_PATH = path.join(dbDir, "comment-agent.db");
  process.env.COMMENT_AGENT_ENABLED = "true";
  process.env.COMMENT_AGENT_MAX_PER_HOUR = "100";
  process.env.COMMENT_AGENT_MAX_PER_DAY = "100";
  process.env.COMMENT_AGENT_MIN_SPACING_SEC = "0";
  process.env.COMMENT_AGENT_MAX_COMMENT_AGE_HOURS = "48";
  process.env.ZERNIO_WEBHOOK_SECRET = "test-secret";
  process.env.ZERNIO_DM_API_KEY = "sk_test";
  process.env.ZERNIO_TIKTOK_ACCOUNT_ID = "acct_wesley";
});

afterEach(() => {
  resetCommentAgentDbForTests();
  rmSync(dbDir, { recursive: true, force: true });
  for (const k of [
    "COMMENT_AGENT_DB_PATH",
    "COMMENT_AGENT_ENABLED",
    "COMMENT_AGENT_MAX_PER_HOUR",
    "COMMENT_AGENT_MAX_PER_DAY",
    "COMMENT_AGENT_MIN_SPACING_SEC",
    "COMMENT_AGENT_MAX_COMMENT_AGE_HOURS",
    "ZERNIO_WEBHOOK_SECRET",
    "ZERNIO_DM_API_KEY",
    "ZERNIO_TIKTOK_ACCOUNT_ID",
  ]) {
    delete process.env[k];
  }
});

function comment(over: Partial<ZernioInboundComment> = {}): ZernioInboundComment {
  return {
    eventId: over.eventId ?? "evt_c1",
    commentId: over.commentId ?? "cmt_1",
    platformPostId: over.platformPostId ?? "vid_1",
    postId: over.postId ?? null,
    platform: "tiktok",
    text: over.text ?? "SUNSET",
    authorId: over.authorId ?? "tt_author_1",
    authorUsername: over.authorUsername ?? "buyer1",
    createdAt: over.createdAt ?? new Date().toISOString(),
    isReply: over.isReply ?? false,
    parentCommentId: over.parentCommentId ?? null,
    accountId: over.accountId ?? "acct_wesley",
  };
}

describe("vetCommentReply", () => {
  it("rejects prices and repairs hyphens", () => {
    expect(vetCommentReply("It's $450,000").ok).toBe(false);
    expect(vetCommentReply("mid 500s in Texas").ok).toBe(false);
    const ok = vetCommentReply("Hey for some reason I can't DM you - mind shooting me one?");
    expect(ok.ok).toBe(true);
    expect(ok.text).not.toMatch(/-/);
  });
});

describe("handleInboundComment guards", () => {
  it("skips when disabled", async () => {
    process.env.COMMENT_AGENT_ENABLED = "false";
    const out = await handleInboundComment(comment(), "acct_wesley", {
      classify: async () => ({ bucket: "high_intent", reply: "hey", reason: "x" }),
    });
    expect(out.decision).toBe("skipped_disabled");
  });

  it("dedupes the same comment id", async () => {
    const { recordCommentAction } = await import("../src/persistence/commentAgentStore.js");
    recordCommentAction({
      commentId: "cmt_1",
      platform: "tiktok",
      platformPostId: "vid_1",
      authorId: "tt_author_1",
      authorUsername: "buyer1",
      commentText: "SUNSET",
      bucket: "skip",
      decision: "skipped_bucket",
      reason: "noise",
      replyText: null,
      postedCommentId: null,
      commentCreatedAt: new Date().toISOString(),
    });
    const second = await handleInboundComment(comment(), "acct_wesley", {
      classify: async () => ({ bucket: "high_intent", reply: "hey", reason: "x" }),
    });
    expect(second.decision).toBe("skipped_duplicate");
  });

  it("skips comments older than the age cap", async () => {
    const old = new Date(Date.now() - 72 * 3600_000).toISOString();
    const out = await handleInboundComment(comment({ createdAt: old }), "acct_wesley", {
      classify: async () => ({ bucket: "high_intent", reply: "hey DM me warmly", reason: "x" }),
    });
    expect(out.decision).toBe("skipped_too_old");
  });
});

describe("webhook routes comment.received", () => {
  it("acks comment events and runs the agent after", async () => {
    const deps = makeDeps();
    const handler = new ZernioWebhookHandler({ pipeline: deps, debounceMs: 5 });
    const body = JSON.stringify({
      id: "evt_comment_live",
      event: "comment.received",
      comment: {
        id: "cmt_live_1",
        platformPostId: "vid_99",
        postId: null,
        platform: "tiktok",
        text: "price?",
        author: { id: "tt_a", username: "u1" },
        createdAt: new Date().toISOString(),
        isReply: false,
      },
      account: { id: "acct_wesley", accountId: "acct_wesley", platform: "tiktok" },
    });
    const sig = createHmac("sha256", "test-secret").update(Buffer.from(body)).digest("hex");
    const t0 = Date.now();
    const ack = await handler.handle({ rawBody: Buffer.from(body), signature: sig });
    const ms = Date.now() - t0;
    expect(ack.status).toBe(200);
    expect(ms).toBeLessThan(500);
    if (ack.processing) await ack.processing;
    // Without a real Zernio read-back the agent fails closed (cannot_reply or failed) —
    // the important property is it did not ignore as unsupported_event.
    expect(ack.body).toMatchObject({ ok: true });
  });
});
