import { randomUUID } from "node:crypto";
import { MemoryStore } from "../src/persistence/memory.js";
import { FakeLlm } from "../src/integrations/llm.js";
import type { LeadHandoff, HandoffResult } from "../src/integrations/handoff.js";
import type { InboundEvent, Lead, Message } from "../src/domain/types.js";
import { ConversationStage } from "../src/domain/types.js";
import { ExampleStore } from "../src/voice/exampleStore.js";
import type { PipelineDeps } from "../src/app/dmPipeline.js";
import { setLogSink } from "../src/observability/logger.js";

// Keep test output quiet; capture log lines for assertions.
export const logLines: string[] = [];
setLogSink((line) => logLines.push(line));

export class RecordingHandoff implements LeadHandoff {
  public calls: Lead[] = [];
  public failNext = false;
  public alwaysFail = false;

  async upsertLead(lead: Lead): Promise<HandoffResult> {
    this.calls.push(lead);
    if (this.failNext || this.alwaysFail) {
      this.failNext = false;
      return { ok: false, detail: "crm down" };
    }
    return { ok: true };
  }
}

export interface TestContext {
  deps: PipelineDeps & { store: MemoryStore; llm: FakeLlm; handoff: RecordingHandoff };
}

export function makeDeps(): TestContext["deps"] {
  return {
    store: new MemoryStore(),
    llm: new FakeLlm(),
    handoff: new RecordingHandoff(),
    exampleStore: new ExampleStore(),
  };
}

export function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    platform: "tiktok",
    externalUserId: "user_123",
    username: "leadperson",
    displayName: "Lead Person",
    message: "hey I saw your video about first time buyers",
    providerMessageId: `msg_${randomUUID()}`,
    wesleyPreviousOutbound: null,
    conversationGoal: null,
    sourceCampaign: null,
    flowKey: null,
    isEcho: false,
    ...overrides,
  };
}

export function makeLead(overrides: Partial<Lead> = {}): Lead {
  const ts = new Date().toISOString();
  return {
    id: randomUUID(),
    platform: "tiktok",
    externalUserId: "user_123",
    username: "leadperson",
    displayName: "Lead Person",
    phone: null,
    email: null,
    stage: ConversationStage.ValueOffered,
    sourceCampaign: null,
    conversationGoal: "wesley_realtor_leads",
    qualification: {},
    tags: [],
    notes: null,
    aliases: ["user_123"],
    optedOut: false,
    createdAt: ts,
    updatedAt: ts,
    lastInboundAt: null,
    lastOutboundAt: null,
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: randomUUID(),
    leadId: "lead_1",
    role: "user",
    text: "hello",
    providerMessageId: null,
    source: "tiktok_manychat",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Model output helpers */
export const modelReply = (reply: string | null, needsHuman = false) => ({
  reply,
  needs_human: needsHuman,
  reason: "test",
});

export const interestedGate = { interested: true, confidence: 0.95, reason: "asked about buying" };
