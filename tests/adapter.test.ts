import { describe, expect, it } from "vitest";
import {
  idempotencyKey,
  normalizeManyChatPayload,
  WebhookRejection,
} from "../src/integrations/manychat.js";

describe("ManyChat webhook adapter", () => {
  it("normalizes the canonical payload", () => {
    const { event } = normalizeManyChatPayload({
      platform: "tiktok",
      user_id: "12345",
      username: "someuser",
      display_name: "Some User",
      message: "hey!",
      message_id: "m1",
      wesley_previous_outbound: "Hey saw your comment",
      source_campaign: "spring",
    });
    expect(event.externalUserId).toBe("12345");
    expect(event.wesleyPreviousOutbound).toBe("Hey saw your comment");
    expect(event.sourceCampaign).toBe("spring");
  });

  it("normalizes the legacy marco_previous_outbound alias without exposing it", () => {
    const { event } = normalizeManyChatPayload({
      platform: "tiktok",
      user_id: "u1",
      message: "hi",
      marco_previous_outbound: "manual opener text",
    });
    expect(event.wesleyPreviousOutbound).toBe("manual opener text");
    expect(JSON.stringify(event)).not.toContain("marco");
  });

  it("rejects an unresolved ManyChat identity token (test #5)", () => {
    expect(() =>
      normalizeManyChatPayload({
        platform: "tiktok",
        user_id: "{{tt_username}}",
        message: "hello",
      }),
    ).toThrowError(WebhookRejection);
    try {
      normalizeManyChatPayload({ platform: "tiktok", username: "{{username}}", message: "x" });
    } catch (e) {
      expect((e as WebhookRejection).statusCode).toBe(400);
      expect((e as WebhookRejection).reason).toContain("unresolved_manychat_token");
    }
  });

  it("does NOT reject braces typed inside the message body", () => {
    const { event } = normalizeManyChatPayload({
      platform: "tiktok",
      user_id: "u9",
      message: "my budget is like {{flexible}} lol",
    });
    expect(event.message).toContain("{{flexible}}");
  });

  it("rejects missing identity with 400", () => {
    try {
      normalizeManyChatPayload({ platform: "tiktok", message: "hi" });
      expect.unreachable();
    } catch (e) {
      expect((e as WebhookRejection).statusCode).toBe(400);
      expect((e as WebhookRejection).reason).toBe("missing_user_identity");
    }
  });

  it("rejects non-TikTok platforms (no Instagram code paths)", () => {
    expect(() =>
      normalizeManyChatPayload({ platform: "instagram", user_id: "u1", message: "hi" }),
    ).toThrowError(WebhookRejection);
  });

  it("flags echo events", () => {
    const { event } = normalizeManyChatPayload({
      platform: "tiktok",
      user_id: "u1",
      message: "hi",
      is_echo: true,
    });
    expect(event.isEcho).toBe(true);
  });

  it("prefers the provider message ID for idempotency", () => {
    const { event } = normalizeManyChatPayload({
      platform: "tiktok",
      user_id: "u1",
      message: "hi",
      message_id: "abc",
    });
    expect(idempotencyKey(event)).toBe("tiktok:msg:abc");
  });
});
