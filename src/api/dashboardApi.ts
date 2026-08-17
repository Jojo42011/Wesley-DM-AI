import type { Store } from "../persistence/types.js";
import { ConversationStage } from "../domain/types.js";

/**
 * Read-only metrics + lead APIs for the dashboard frontend.
 * Contact values are partially masked — the dashboard is a monitoring
 * surface, not a data-export tool.
 */

/** Leads created from the /testing console — hidden from dashboard metrics. */
export const TEST_LEAD_PREFIX = "dmtest_";

function isTestLead(externalUserId: string): boolean {
  return externalUserId.startsWith(TEST_LEAD_PREFIX);
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length > 4 ? `•••• ${phone.slice(-4)}` : phone;
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [user, domain] = email.split("@");
  if (!user || !domain) return email;
  return `${user.slice(0, 2)}•••@${domain}`;
}

export async function getMetrics(store: Store): Promise<Record<string, unknown>> {
  const leads = (await store.leads.list(2000, 0)).filter((l) => !isTestLead(l.externalUserId));
  const msgCounts = await store.conversations.countMessages(TEST_LEAD_PREFIX);

  const totalLeads = leads.length;
  const captured = leads.filter((l) => l.phone || l.email);
  const optedOut = leads.filter((l) => l.optedOut);
  const inReview = leads.filter((l) => l.stage === ConversationStage.HumanReview);
  const active = leads.filter(
    (l) =>
      !l.optedOut &&
      l.stage !== ConversationStage.Closed &&
      l.stage !== ConversationStage.HumanReview,
  );

  // Funnel counts by stage.
  const funnel: Record<string, number> = {};
  for (const stage of Object.values(ConversationStage)) funnel[stage] = 0;
  for (const l of leads) funnel[l.stage] = (funnel[l.stage] ?? 0) + 1;

  // Leads + captures per day, last 14 days.
  const days: Array<{ date: string; leads: number; captured: number }> = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ date: key, leads: 0, captured: 0 });
  }
  const dayIndex = new Map(days.map((d, i) => [d.date, i]));
  for (const l of leads) {
    const created = l.createdAt.slice(0, 10);
    const idx = dayIndex.get(created);
    if (idx !== undefined) {
      days[idx]!.leads++;
      if (l.phone || l.email) days[idx]!.captured++;
    }
  }

  const captureRate = totalLeads ? captured.length / totalLeads : 0;

  return {
    totals: {
      leads: totalLeads,
      captured: captured.length,
      captureRate,
      active: active.length,
      optedOut: optedOut.length,
      humanReview: inReview.length,
      messagesIn: msgCounts.user,
      messagesOut: msgCounts.assistant,
    },
    funnel,
    daily: days,
    generatedAt: new Date().toISOString(),
  };
}

export async function getLeads(store: Store, limit = 100): Promise<unknown[]> {
  const leads = (await store.leads.list(limit, 0)).filter((l) => !isTestLead(l.externalUserId));
  return leads.map((l) => ({
    id: l.id,
    username: l.username ?? l.externalUserId,
    displayName: l.displayName,
    phone: maskPhone(l.phone),
    email: maskEmail(l.email),
    hasContact: Boolean(l.phone || l.email),
    stage: l.stage,
    optedOut: l.optedOut,
    qualification: l.qualification,
    createdAt: l.createdAt,
    lastInboundAt: l.lastInboundAt,
  }));
}

/**
 * State of a test-console lead (unmasked stage/contact so the tester can see
 * exactly what the pipeline captured). Only serves dmtest_ leads.
 */
export async function getTestLeadState(
  store: Store,
  externalUserId: string,
): Promise<unknown | null> {
  if (!isTestLead(externalUserId)) return null;
  const lead = await store.leads.findByExternalId("tiktok", externalUserId);
  if (!lead) return null;
  return {
    leadId: lead.id,
    stage: lead.stage,
    phone: lead.phone,
    email: lead.email,
    optedOut: lead.optedOut,
    qualification: lead.qualification,
  };
}

export async function getLeadConversation(
  store: Store,
  leadId: string,
): Promise<unknown | null> {
  const lead = await store.leads.get(leadId);
  if (!lead) return null;
  const messages = await store.conversations.getMessages(leadId, 100);
  return {
    lead: {
      id: lead.id,
      username: lead.username ?? lead.externalUserId,
      displayName: lead.displayName,
      stage: lead.stage,
      phone: maskPhone(lead.phone),
      email: maskEmail(lead.email),
      qualification: lead.qualification,
      createdAt: lead.createdAt,
    },
    messages: messages.map((m) => ({
      role: m.role,
      text: m.text,
      source: m.source,
      createdAt: m.createdAt,
    })),
  };
}
