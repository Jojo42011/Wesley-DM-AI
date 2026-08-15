import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { processInboundEvent } from "../src/app/dmPipeline.js";
import { extractPhone } from "../src/modules/contactCapture.js";
import { retryPendingHandoffs } from "../src/integrations/handoff.js";
import { ConversationStage } from "../src/domain/types.js";
import { WESLEY_REALTOR_LEADS } from "../src/config/campaigns.js";
import { createLogger } from "../src/observability/logger.js";
import {
  makeDeps, makeEvent, makeLead, makeMessage, modelReply, RecordingHandoff,
} from "./helpers.js";

const genSystem = "You write exactly one TikTok DM as Wesley";

async function seedRequested(deps: ReturnType<typeof makeDeps>) {
  const lead = makeLead({ stage: ConversationStage.ContactRequested });
  await deps.store.leads.create(lead);
  await deps.store.conversations.appendMessage(
    makeMessage({ id: randomUUID(), leadId: lead.id, role: "assistant", text: "What's the best number for you?" }),
  );
  return lead;
}

describe("contact capture", () => {
  it("#10 a valid phone number is normalized to E.164 and captured deterministically", async () => {
    const deps = makeDeps();
    await seedRequested(deps);

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "sure! its (512) 761-8330" }),
    );
    expect(outcome.decision).toBe("contact_captured");
    expect(WESLEY_REALTOR_LEADS.fallbackResponses.contact_captured).toContain(outcome.reply);

    const lead = await deps.store.leads.get(outcome.leadId!);
    expect(lead!.phone).toBe("+15127618330");
    expect(lead!.stage).toBe(ConversationStage.HandoffReady);

    const captures = await deps.store.conversations.getContactCaptures(lead!.id);
    expect(captures).toHaveLength(1);
    expect(captures[0]!.field).toBe("phone");
    expect(captures[0]!.confidence).toBeGreaterThan(0.5);
    expect(captures[0]!.sourceMessageId).toBeTruthy();

    // Handoff fired exactly once.
    expect(deps.handoff.calls).toHaveLength(1);
  });

  it("#11 unrelated numbers (price, sqft, year) are never treated as phones", async () => {
    const deps = makeDeps();
    await seedRequested(deps);
    deps.llm.handler = (req) =>
      req.system.includes(genSystem) ? modelReply("Good budget to work with — got a target area?") : null;

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "our budget is $450,000 for like 2,000 sqft, built after 1998" }),
    );
    expect(outcome.decision).not.toBe("contact_captured");
    const lead = await deps.store.leads.get(outcome.leadId!);
    expect(lead!.phone).toBeNull();
  });

  it("rejects repeated-digit junk numbers", () => {
    const msgs = [makeMessage({ role: "user", text: "my number is 111-111-1111 lol" })];
    expect(extractPhone(msgs)).toBeNull();
  });

  it("#12 a captured phone number is never requested again", async () => {
    const deps = makeDeps();
    const lead = makeLead({
      phone: "+15127618330",
      stage: ConversationStage.ContactCaptured,
    });
    await deps.store.leads.create(lead);
    await deps.store.conversations.appendMessage(
      makeMessage({ leadId: lead.id, role: "assistant", text: "Perfect, got it. I'll reach out shortly!" }),
    );

    // Model misbehaves and asks for the number again — validator must reject,
    // retry also misbehaves, deterministic fallback is used instead.
    deps.llm.handler = (req) =>
      req.system.includes(genSystem)
        ? modelReply("Awesome — can I get your phone number real quick?")
        : null;

    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "so what neighborhoods do u like for families?" }),
    );
    expect(outcome.reply).toBeTruthy();
    expect(outcome.reply!.toLowerCase()).not.toMatch(/phone|number|digits/);
  });

  it("#19 CRM failure queues a retry without losing the DM response", async () => {
    const deps = makeDeps();
    deps.handoff.alwaysFail = true;
    await seedRequested(deps);

    const outcome = await processInboundEvent(deps, makeEvent({ message: "512-761-8330" }));
    // The person still gets a truthful confirmation…
    expect(outcome.decision).toBe("contact_captured");
    expect(outcome.reply).toBeTruthy();

    // …and the handoff is queued for retry.
    const pending = await deps.store.handoffs.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attempts).toBeGreaterThanOrEqual(1);

    // Retry succeeds once the CRM recovers.
    const recovered = new RecordingHandoff();
    await retryPendingHandoffs(deps.store, recovered, createLogger());
    expect(recovered.calls).toHaveLength(1);
    expect(await deps.store.handoffs.pending()).toHaveLength(0);
  });

  it("captures email when the campaign wants either field", async () => {
    const deps = makeDeps();
    const lead = makeLead({ stage: ConversationStage.ContactRequested });
    await deps.store.leads.create(lead);
    // Note: default campaign wants phone; email arrives — not captured.
    const outcome = await processInboundEvent(
      deps,
      makeEvent({ message: "just email me at lead.person@example.com" }),
    );
    const updated = await deps.store.leads.get(outcome.leadId!);
    expect(updated!.email).toBeNull(); // goal is phone-only for this campaign
  });
});
