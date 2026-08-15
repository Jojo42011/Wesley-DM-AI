import { randomUUID } from "node:crypto";
import type { Lead, Message } from "../domain/types.js";
import { ConversationStage } from "../domain/types.js";
import type { Store } from "../persistence/types.js";

/**
 * Manual opener seeding. Wesley may manually DM someone first; when they
 * reply, ManyChat sends `wesley_previous_outbound`. We seed it exactly once
 * — only when the conversation has no assistant messages — preserving the
 * original wording (trimmed only).
 */

export interface SeedResult {
  seeded: boolean;
  message: Message | null;
  stage: ConversationStage;
}

/** Infer how far the seeded opener moves the stage, from its content only. */
export function stageForOpener(openerText: string): ConversationStage {
  const t = openerText.toLowerCase();
  const asksForContact =
    /\b(number|phone|text you|call you|email)\b/.test(t) && /\?|send|drop|what'?s/.test(t);
  if (asksForContact) return ConversationStage.ContactRequested;
  const makesOffer = /\b(i can|happy to|i'?ll send|let me|free|help you)\b/.test(t);
  if (makesOffer) return ConversationStage.ValueOffered;
  if (t.includes("?")) return ConversationStage.ClarificationPending;
  return ConversationStage.ClarificationPending;
}

export async function seedManualOpener(
  store: Store,
  lead: Lead,
  openerText: string | null,
): Promise<SeedResult> {
  if (!openerText || !openerText.trim()) {
    return { seeded: false, message: null, stage: lead.stage };
  }
  const assistantCount = await store.conversations.countAssistantMessages(lead.id);
  if (assistantCount > 0) {
    // Never seed again on later webhook calls.
    return { seeded: false, message: null, stage: lead.stage };
  }
  const text = openerText.trim();
  const message: Message = {
    id: randomUUID(),
    leadId: lead.id,
    role: "assistant",
    text,
    providerMessageId: null,
    source: "manual_seed",
    createdAt: new Date(Date.now() - 1000).toISOString(), // just before the inbound reply
  };
  await store.conversations.appendMessage(message);
  return { seeded: true, message, stage: stageForOpener(text) };
}
