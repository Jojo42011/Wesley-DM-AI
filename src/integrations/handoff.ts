import { randomUUID } from "node:crypto";
import type { HandoffJob, Lead, Message } from "../domain/types.js";
import type { Store } from "../persistence/types.js";
import type { Logger } from "../observability/logger.js";

/**
 * Downstream handoff. CRM-agnostic interface; failures queue a retryable
 * job — the DM reply never fails because a CRM is down, and the bot never
 * falsely claims the handoff completed.
 */

export interface HandoffResult {
  ok: boolean;
  detail?: string;
}

export interface LeadHandoff {
  upsertLead(lead: Lead, conversation: Message[]): Promise<HandoffResult>;
}

/** No-op handoff for local dev / until a CRM is configured. */
export class NullHandoff implements LeadHandoff {
  async upsertLead(): Promise<HandoffResult> {
    return { ok: true, detail: "no crm configured" };
  }
}

/** Generic webhook handoff (Zapier / Make / CRM endpoint via HANDOFF_WEBHOOK_URL). */
export class WebhookHandoff implements LeadHandoff {
  constructor(private readonly url: string) {}

  async upsertLead(lead: Lead, conversation: Message[]): Promise<HandoffResult> {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lead, conversation: conversation.slice(-20) }),
      });
      return res.ok
        ? { ok: true }
        : { ok: false, detail: `handoff endpoint returned ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : "network error" };
    }
  }
}

/**
 * Triggers the handoff idempotently. Key = leadId + type + state version so
 * the same capture never fires twice; failure records a retryable job.
 */
export async function triggerHandoff(
  store: Store,
  handoff: LeadHandoff,
  lead: Lead,
  type: string,
  stateVersion: string,
  logger: Logger,
): Promise<void> {
  const idempotencyKey = `${lead.id}:${type}:${stateVersion}`;
  const now = new Date().toISOString();
  const job: HandoffJob = {
    id: randomUUID(),
    leadId: lead.id,
    type,
    idempotencyKey,
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  const enqueued = await store.handoffs.enqueue(job);
  if (!enqueued) return; // already handed off for this state version

  logger.log("handoff_queued", { leadId: lead.id, type });
  const conversation = await store.conversations.getMessages(lead.id);
  const result = await handoff.upsertLead(lead, conversation);
  if (result.ok) {
    await store.handoffs.markCompleted(enqueued.id);
    logger.log("handoff_completed", { leadId: lead.id, type });
  } else {
    await store.handoffs.markFailed(enqueued.id);
    logger.log("handoff_failed", { leadId: lead.id, type, detail: result.detail });
  }
}

/** Retry worker — call periodically (setInterval in server.ts). */
export async function retryPendingHandoffs(
  store: Store,
  handoff: LeadHandoff,
  logger: Logger,
  maxAttempts = 8,
): Promise<void> {
  const pending = await store.handoffs.pending(25);
  for (const job of pending) {
    if (job.attempts >= maxAttempts) continue;
    const lead = await store.leads.get(job.leadId);
    if (!lead) continue;
    const conversation = await store.conversations.getMessages(lead.id);
    const result = await handoff.upsertLead(lead, conversation);
    if (result.ok) {
      await store.handoffs.markCompleted(job.id);
      logger.log("handoff_completed", { leadId: lead.id, type: job.type, retried: true });
    } else {
      await store.handoffs.markFailed(job.id);
    }
  }
}
