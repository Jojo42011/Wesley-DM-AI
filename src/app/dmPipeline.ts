import { randomUUID } from "node:crypto";
import type {
  DmCampaignPolicy,
  InboundEvent,
  Lead,
  Message,
  PipelineOutcome,
  VoiceProfile,
} from "../domain/types.js";
import { ConversationStage } from "../domain/types.js";
import { transition } from "../domain/transitions.js";
import { getCampaign } from "../config/campaigns.js";
import { WESLEY_VOICE_PROFILE } from "../config/wesleyVoice.js";
import type { Store } from "../persistence/types.js";
import type { LlmClient } from "../integrations/llm.js";
import { REPLY_JSON_SCHEMA, ReplySchema } from "../integrations/llm.js";
import type { LeadHandoff } from "../integrations/handoff.js";
import { triggerHandoff } from "../integrations/handoff.js";
import { idempotencyKey } from "../integrations/manychat.js";
import { createLogger, preview, type Logger } from "../observability/logger.js";
import { runIntentGate } from "../modules/intentGate.js";
import { seedManualOpener, stageForOpener } from "../modules/openingDm.js";
import { extractEmail, extractPhone } from "../modules/contactCapture.js";
import {
  isAgreement,
  isCloseout,
  isCtaRefusal,
  isDirectQuestion,
  isOptOut,
  isSimpleAcknowledgment,
  saysAlreadySent,
} from "../modules/closeout.js";
import { extractQualificationSignals } from "../modules/qualification.js";
import { runPreflight } from "./preflight.js";
import { buildSystemPrompt, buildUserPrompt } from "./promptBuilder.js";
import { buildRetroactiveFix, validateReply } from "./responseValidator.js";
import { selectFallback } from "./fallbacks.js";
import { isNearDuplicate } from "./similarity.js";
import type { ExampleStore } from "../voice/exampleStore.js";
import { retrieveExamples } from "../voice/exampleRetrieval.js";

const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 3600;

export interface PipelineDeps {
  store: Store;
  llm: LlmClient;
  handoff: LeadHandoff;
  exampleStore: ExampleStore;
  voiceProfile?: VoiceProfile;
  logger?: Logger;
}

function now(): string {
  return new Date().toISOString();
}

function newLead(event: InboundEvent, policy: DmCampaignPolicy): Lead {
  const ts = now();
  return {
    id: randomUUID(),
    platform: "tiktok",
    externalUserId: event.externalUserId,
    username: event.username,
    displayName: event.displayName,
    phone: null,
    email: null,
    stage: ConversationStage.New,
    sourceCampaign: event.sourceCampaign,
    conversationGoal: event.conversationGoal ?? policy.key,
    qualification: {},
    tags: [],
    notes: null,
    aliases: [event.externalUserId, event.username].filter(Boolean) as string[],
    optedOut: false,
    createdAt: ts,
    updatedAt: ts,
    lastInboundAt: null,
    lastOutboundAt: null,
  };
}

/** Did Wesley's last message commit to an action ("I'll text you", etc.)? */
function lastOutboundCommitted(messages: Message[]): boolean {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return false;
  return /\b(i'?ll|i will|expect|got it|locked in|reach out|text you|call you|send (it|that|you))\b/i.test(
    lastAssistant.text,
  );
}

export async function processInboundEvent(
  deps: PipelineDeps,
  event: InboundEvent,
): Promise<PipelineOutcome> {
  const logger = (deps.logger ?? createLogger()).child({ user: event.externalUserId });
  const started = Date.now();

  if (event.isEcho) {
    logger.log("inbound_rejected", { reason: "echo_event" });
    return { reply: null, leadId: null, stageBefore: null, stageAfter: null, decision: "echo_ignored", suppressed: true };
  }

  // Durable idempotency — a repeated provider message ID never produces a
  // second reply.
  const idemKey = idempotencyKey(event);
  const fresh = await deps.store.idempotency.claim(idemKey, IDEMPOTENCY_TTL_SECONDS);
  if (!fresh) {
    logger.log("inbound_rejected", { reason: "duplicate_event", idemKey });
    return { reply: null, leadId: null, stageBefore: null, stageAfter: null, decision: "duplicate_ignored", suppressed: true };
  }

  const lockKey = `tiktok:${event.externalUserId}`;
  // Distinct rapid messages queue behind the lock — serialized, never dropped.
  return deps.store.withConversationLock(lockKey, () =>
    processLocked(deps, event, logger, started),
  );
}

async function processLocked(
  deps: PipelineDeps,
  event: InboundEvent,
  logger: Logger,
  started: number,
): Promise<PipelineOutcome> {
  const { store, llm } = deps;
  const policy = getCampaign(event.conversationGoal ?? event.sourceCampaign);
  const voiceProfile = deps.voiceProfile ?? WESLEY_VOICE_PROFILE;

  /* ------------------------------------------------ lead load / creation */
  let lead =
    (await store.leads.findByExternalId("tiktok", event.externalUserId)) ??
    (event.username ? await store.leads.findByAlias("tiktok", event.username) : null);

  let createdNow = false;
  if (!lead) {
    // A person replying to a seeded Wesley opener is clearly engaged — no
    // cold-lead intent gate for them.
    if (!event.wesleyPreviousOutbound) {
      const gate = await runIntentGate(llm, policy, event.message);
      logger.log("intent_gate", { action: gate.action, reason: gate.reason });
      if (gate.action === "reject") {
        return {
          reply: null, leadId: null, stageBefore: null, stageAfter: null,
          decision: `gate_rejected:${gate.reason}`, suppressed: true,
        };
      }
      lead = newLead(event, policy);
      if (gate.action === "escalate") lead.stage = ConversationStage.HumanReview;
      await store.leads.create(lead);
      createdNow = true;
      if (gate.action === "escalate") {
        // Store their message, notify workflow, send approved ack only.
        await appendUserMessage(store, lead, event);
        const ack = selectFallback(policy, "human_handoff", []);
        await appendAssistantMessage(store, lead, ack, "automation");
        logger.log("escalation", { leadId: lead.id, rule: "intent_gate_unsafe" });
        return finish(logger, started, lead, lead.stage, lead.stage, ack, "escalated_at_gate", false);
      }
      if (gate.action === "clarify") {
        await appendUserMessage(store, lead, event);
        const clar = selectFallback(policy, "clarification", []);
        await appendAssistantMessage(store, lead, clar, "automation");
        lead.stage = ConversationStage.ClarificationPending;
        lead.lastInboundAt = now();
        lead.lastOutboundAt = now();
        await store.leads.update(lead);
        return finish(logger, started, lead, ConversationStage.New, lead.stage, clar, "gate_clarify", false);
      }
    } else {
      lead = newLead(event, policy);
      await store.leads.create(lead);
      createdNow = true;
    }
  }

  const stageBefore = lead.stage;
  logger.log("inbound_accepted", { leadId: lead.id, preview: preview(event.message) });

  // Keep aliases fresh so a username change never duplicates the lead.
  if (event.username && lead.username !== event.username) {
    if (lead.username) lead.aliases = [...new Set([...lead.aliases, lead.username])];
    lead.username = event.username;
    lead.aliases = [...new Set([...lead.aliases, event.username])];
  }

  /* --------------------------------------- opt-out: durable suppression */
  if (lead.optedOut) {
    await appendUserMessage(store, lead, event);
    logger.log("reply_suppressed", { leadId: lead.id, reason: "opted_out" });
    return finish(logger, started, lead, stageBefore, lead.stage, null, "suppressed_opt_out", true);
  }

  /* -------------------------------- manual opener seeding (exactly once) */
  const seeded = await seedManualOpener(store, lead, event.wesleyPreviousOutbound);
  if (seeded.seeded) {
    lead.stage = transition(lead.stage, seeded.stage);
    lead.lastOutboundAt = lead.lastOutboundAt ?? seeded.message!.createdAt;
    logger.log("manual_opener_seeded", { leadId: lead.id, stage: lead.stage });
  }

  /* ------------------------- append inbound user message (exactly once) */
  const userMessage = await appendUserMessage(store, lead, event);
  lead.lastInboundAt = userMessage.createdAt;

  const messages = await store.conversations.getMessages(lead.id);
  const text = event.message;

  // Enrich qualification signals (additive, never blocking).
  lead.qualification = extractQualificationSignals(lead, text);

  /* =================== DETERMINISTIC GUARDS (documented priority order) */

  // G1 invalid/false trigger handled at the gate; G3 duplicates handled by
  // idempotency above.

  // G2 — safety / human escalation (regex rules from policy).
  for (const rule of policy.escalationRules) {
    if (rule.patterns.some((p) => new RegExp(p, "i").test(text))) {
      lead.stage = transition(lead.stage, ConversationStage.HumanReview);
      await store.leads.update(lead);
      logger.log("deterministic_guard", { guard: "escalation", rule: rule.key, leadId: lead.id });
      logger.log("escalation", { leadId: lead.id, rule: rule.key });
      const ack = selectFallback(policy, "human_handoff", messages);
      await appendAssistantMessage(store, lead, ack, "automation");
      lead.lastOutboundAt = now();
      await store.leads.update(lead);
      return finish(logger, started, lead, stageBefore, lead.stage, ack, `escalated:${rule.key}`, false);
    }
  }

  // Opt-out (consent beats everything after safety).
  if (isOptOut(text)) {
    lead.optedOut = true;
    lead.stage = transition(lead.stage, ConversationStage.Closed);
    await store.conversations.recordOptOut({
      leadId: lead.id,
      messageText: text,
      occurredAt: now(),
    });
    await store.leads.update(lead);
    logger.log("opt_out", { leadId: lead.id });
    const confirmation = policy.optOutConfirmation || null;
    if (confirmation) {
      await appendAssistantMessage(store, lead, confirmation, "automation");
      lead.lastOutboundAt = now();
      await store.leads.update(lead);
    }
    return finish(logger, started, lead, stageBefore, lead.stage, confirmation, "opt_out", !confirmation);
  }

  // G5 — contact information newly captured (deterministic extraction).
  const captureOutcome = await handleContactCapture(deps, policy, lead, messages, logger);
  if (captureOutcome) {
    return finish(logger, started, lead, stageBefore, lead.stage, captureOutcome, "contact_captured", false);
  }

  // G4 — acknowledgment after a commitment → natural silence.
  const silenceRule = policy.silenceRules.find((r) => r.key === "ack_after_commitment");
  if (
    silenceRule?.preferSilence &&
    isSimpleAcknowledgment(text) &&
    lastOutboundCommitted(messages.slice(0, -1))
  ) {
    logger.log("deterministic_guard", { guard: "ack_silence", leadId: lead.id });
    logger.log("reply_suppressed", { leadId: lead.id, reason: "ack_after_commitment" });
    await store.leads.update(lead);
    return finish(logger, started, lead, stageBefore, lead.stage, null, "silence_after_ack", true);
  }

  // G6 — person says they already sent the requested info, but we don't have it.
  if (saysAlreadySent(text)) {
    const missingPhone = policy.contactFieldGoal !== "email" && !lead.phone;
    const missingEmail = policy.contactFieldGoal !== "phone" && !lead.email;
    if ((policy.contactFieldGoal === "phone" && missingPhone) ||
        (policy.contactFieldGoal === "email" && missingEmail) ||
        (policy.contactFieldGoal === "either" && missingPhone && missingEmail)) {
      logger.log("deterministic_guard", { guard: "already_sent", leadId: lead.id });
      const reply = selectFallback(policy, "info_already_sent", messages);
      await appendAssistantMessage(store, lead, reply, "automation");
      lead.lastOutboundAt = now();
      await store.leads.update(lead);
      return finish(logger, started, lead, stageBefore, lead.stage, reply, "already_sent_not_received", false);
    }
  }

  // G7 — direct question with a policy-approved pinned answer.
  if (isDirectQuestion(text)) {
    for (const pinned of policy.pinnedAnswers) {
      if (pinned.patterns.some((p) => new RegExp(p, "i").test(text))) {
        logger.log("deterministic_guard", { guard: "pinned_answer", leadId: lead.id });
        await appendAssistantMessage(store, lead, pinned.answer, "automation");
        lead.lastOutboundAt = now();
        await store.leads.update(lead);
        return finish(logger, started, lead, stageBefore, lead.stage, pinned.answer, "pinned_answer", false);
      }
    }
  }

  // G8 — explicit refusal of the CTA → lower-pressure angle, never nagging.
  if (isCtaRefusal(text)) {
    logger.log("deterministic_guard", { guard: "cta_refusal", leadId: lead.id });
    const reply = selectFallback(policy, "cta_resistance", messages);
    lead.stage = transition(lead.stage, ConversationStage.FollowUpDue);
    await appendAssistantMessage(store, lead, reply, "automation");
    lead.lastOutboundAt = now();
    await store.leads.update(lead);
    return finish(logger, started, lead, stageBefore, lead.stage, reply, "cta_refused", false);
  }

  // G9 — agreement to the offer → next deterministic CTA (unless captured).
  if (
    isAgreement(text) &&
    !isDirectQuestion(text) &&
    (lead.stage === ConversationStage.ValueOffered ||
      lead.stage === ConversationStage.ContactRequested ||
      lead.stage === ConversationStage.ClarificationPending) &&
    policy.contactFieldGoal !== "none" &&
    !lead.phone && !lead.email
  ) {
    logger.log("deterministic_guard", { guard: "agreement_cta", leadId: lead.id });
    const reply = selectFallback(policy, "cta_request", messages);
    lead.stage = transition(lead.stage, ConversationStage.ContactRequested);
    await appendAssistantMessage(store, lead, reply, "automation");
    lead.lastOutboundAt = now();
    await store.leads.update(lead);
    return finish(logger, started, lead, stageBefore, lead.stage, reply, "agreement_cta", false);
  }

  // G10 — conversation closeout.
  if (isCloseout(text)) {
    logger.log("deterministic_guard", { guard: "closeout", leadId: lead.id });
    lead.stage = transition(lead.stage, ConversationStage.Closed);
    if (isSimpleAcknowledgment(text) || lastOutboundCommitted(messages.slice(0, -1))) {
      await store.leads.update(lead);
      logger.log("reply_suppressed", { leadId: lead.id, reason: "closeout" });
      return finish(logger, started, lead, stageBefore, lead.stage, null, "closeout_silent", true);
    }
    const reply = selectFallback(policy, "closeout", messages);
    await appendAssistantMessage(store, lead, reply, "automation");
    lead.lastOutboundAt = now();
    await store.leads.update(lead);
    return finish(logger, started, lead, stageBefore, lead.stage, reply, "closeout", false);
  }

  /* ============================== G11 — model-generated reply pathway */

  const preflight = await runPreflight(llm, messages);
  logger.log("preflight_complete", {
    leadId: lead.id,
    sentiment: preflight.sentiment,
    userRepeated: preflight.userRepeated,
    wesleyRepeated: preflight.wesleyRepeated,
    shouldReply: preflight.shouldReply,
  });

  if (preflight.shouldEscalate) {
    lead.stage = transition(lead.stage, ConversationStage.HumanReview);
    const ack = selectFallback(policy, "human_handoff", messages);
    await appendAssistantMessage(store, lead, ack, "automation");
    lead.lastOutboundAt = now();
    await store.leads.update(lead);
    logger.log("escalation", { leadId: lead.id, rule: "preflight" });
    return finish(logger, started, lead, stageBefore, lead.stage, ack, "escalated_preflight", false);
  }

  if (!preflight.shouldReply) {
    await store.leads.update(lead);
    logger.log("reply_suppressed", { leadId: lead.id, reason: "preflight_no_reply" });
    return finish(logger, started, lead, stageBefore, lead.stage, null, "preflight_silence", true);
  }

  const capturedFields = [
    lead.phone ? "phone (already captured — never ask again)" : null,
    lead.email ? "email (already captured — never ask again)" : null,
  ].filter(Boolean) as string[];

  const examples = retrieveExamples(deps.exampleStore, {
    stage: lead.stage,
    sentiment: preflight.sentiment,
  });

  const promptInputs = {
    policy,
    voiceProfile,
    examples,
    lead,
    messages,
    latestUserMessage: text,
    wesleyPreviousOutbound: event.wesleyPreviousOutbound,
    preflight,
    capturedFields,
  };

  const generate = (extraInstruction?: string) =>
    llm.completeJson(
      {
        system: buildSystemPrompt({ ...promptInputs, extraInstruction }),
        user: buildUserPrompt(promptInputs),
        maxTokens: 512,
      },
      ReplySchema,
      REPLY_JSON_SCHEMA,
    );

  let decision = "model_reply";
  let finalReply: string | null = null;

  const first = await generate();
  if (first === null) {
    // Provider failure or invalid JSON → deterministic fallback, never a crash.
    decision = "fallback_model_failure";
    finalReply = pickSituationalFallback(policy, lead, messages, createdNow);
    logger.log("reply_fallback", { leadId: lead.id, reason: "model_failure" });
  } else if (first.needs_human) {
    lead.stage = transition(lead.stage, ConversationStage.HumanReview);
    finalReply = selectFallback(policy, "human_handoff", messages);
    decision = "model_needs_human";
    logger.log("escalation", { leadId: lead.id, rule: "model_needs_human" });
  } else if (first.reply === null) {
    await store.leads.update(lead);
    logger.log("reply_suppressed", { leadId: lead.id, reason: "model_chose_silence" });
    return finish(logger, started, lead, stageBefore, lead.stage, null, "model_silence", true);
  } else {
    const v1 = validateReply(first.reply, policy, lead, messages, {
      sentiment: preflight.sentiment,
      closedTopics: preflight.closedTopics,
    });
    if (v1.ok) {
      finalReply = v1.reply;
      logger.log("reply_generated", { leadId: lead.id, length: v1.reply.length });
    } else {
      logger.log("reply_rejected", { leadId: lead.id, reasons: v1.reasons });
      // One retry with RETROACTIVE_FIX, then deterministic fallback.
      const second = await generate(buildRetroactiveFix(v1));
      logger.log("reply_retried", { leadId: lead.id });
      if (second?.reply) {
        const v2 = validateReply(second.reply, policy, lead, messages, {
          sentiment: preflight.sentiment,
          closedTopics: preflight.closedTopics,
        });
        if (v2.ok) {
          finalReply = v2.reply;
          decision = "model_reply_retry";
          logger.log("reply_generated", { leadId: lead.id, retry: true });
        }
      }
      if (!finalReply) {
        decision = "fallback_after_rejection";
        finalReply = pickSituationalFallback(policy, lead, messages, createdNow);
        logger.log("reply_fallback", { leadId: lead.id, reason: "validation_failed_twice" });
      }
    }
  }

  // Concurrency re-check: only persist if OUR user turn is still the latest
  // unanswered message (another turn may have queued behind us).
  const latest = await store.conversations.getLatestMessage(lead.id);
  if (latest && latest.id !== userMessage.id && latest.role === "user") {
    logger.log("reply_suppressed", { leadId: lead.id, reason: "newer_user_message" });
    await store.leads.update(lead);
    return finish(logger, started, lead, stageBefore, lead.stage, null, "superseded", true);
  }

  // Deterministic stage advancement from what the reply actually does.
  if (finalReply && /\b(number|phone|digits)\b/i.test(finalReply) && !lead.phone) {
    lead.stage = transition(lead.stage, ConversationStage.ContactRequested);
  } else if (lead.stage === ConversationStage.New) {
    lead.stage = transition(lead.stage, ConversationStage.ClarificationPending);
  }

  if (finalReply) {
    await appendAssistantMessage(store, lead, finalReply, "automation");
    lead.lastOutboundAt = now();
  }
  await store.leads.update(lead);
  return finish(logger, started, lead, stageBefore, lead.stage, finalReply, decision, finalReply === null);
}

/**
 * Records a message the HUMAN side sent (Wesley typing manually in the
 * respond.io inbox, or our own reply echoing back) as an assistant turn.
 * Never generates a reply.
 *
 * This is how the manual opener is preserved: when the lead answers, the
 * pipeline already has Wesley's exact words in history, so the agent
 * continues the conversation instead of restarting it.
 */
export async function recordOutboundMessage(
  deps: Pick<PipelineDeps, "store" | "logger">,
  params: {
    externalUserId: string;
    username?: string | null;
    displayName?: string | null;
    text: string;
    providerMessageId?: string | null;
    campaignKey?: string | null;
  },
): Promise<{ recorded: boolean; leadId: string | null; reason: string }> {
  const { store } = deps;
  const logger = (deps.logger ?? createLogger()).child({ user: params.externalUserId });
  const text = params.text.trim();
  if (!text) return { recorded: false, leadId: null, reason: "empty_text" };

  const policy = getCampaign(params.campaignKey);

  return store.withConversationLock(`tiktok:${params.externalUserId}`, async () => {
    let lead = await store.leads.findByExternalId("tiktok", params.externalUserId);
    if (!lead) {
      // Wesley messaged them first: create the lead so the opener has a home.
      lead = newLead(
        {
          platform: "tiktok",
          externalUserId: params.externalUserId,
          username: params.username ?? null,
          displayName: params.displayName ?? null,
          message: "",
          providerMessageId: null,
          wesleyPreviousOutbound: null,
          conversationGoal: null,
          sourceCampaign: params.campaignKey ?? null,
          flowKey: null,
          isEcho: false,
        },
        policy,
      );
      await store.leads.create(lead);
    }

    const existing = await store.conversations.getMessages(lead.id);

    // Our own delivered replies echo back through the same webhook. Skip
    // anything we already have, so the thread never doubles up.
    const recentAssistant = existing.filter((m) => m.role === "assistant").slice(-5);
    if (recentAssistant.some((m) => isNearDuplicate(m.text, text, 0.9))) {
      return { recorded: false, leadId: lead.id, reason: "already_recorded" };
    }

    const isFirstOutbound = recentAssistant.length === 0;
    await appendAssistantMessage(store, lead, text, "manual_seed");

    if (isFirstOutbound) {
      lead.stage = transition(lead.stage, stageForOpener(text));
    }
    lead.lastOutboundAt = now();
    await store.leads.update(lead);

    logger.log("manual_opener_seeded", {
      leadId: lead.id,
      firstOutbound: isFirstOutbound,
      stage: lead.stage,
      preview: preview(text),
    });
    return { recorded: true, leadId: lead.id, reason: isFirstOutbound ? "opener" : "manual_reply" };
  });
}

/* ------------------------------------------------------------- helpers */

async function appendUserMessage(store: Store, lead: Lead, event: InboundEvent): Promise<Message> {
  const message: Message = {
    id: randomUUID(),
    leadId: lead.id,
    role: "user",
    text: event.message,
    providerMessageId: event.providerMessageId,
    source: "tiktok_manychat",
    createdAt: now(),
  };
  await store.conversations.appendMessage(message);
  return message;
}

async function appendAssistantMessage(
  store: Store,
  lead: Lead,
  text: string,
  source: Message["source"],
): Promise<Message> {
  const message: Message = {
    id: randomUUID(),
    leadId: lead.id,
    role: "assistant",
    text,
    providerMessageId: null,
    source,
    createdAt: now(),
  };
  await store.conversations.appendMessage(message);
  return message;
}

/**
 * G5 — deterministic contact capture. Returns the confirmation reply when a
 * NEW goal field was captured, else null.
 */
async function handleContactCapture(
  deps: PipelineDeps,
  policy: DmCampaignPolicy,
  lead: Lead,
  messages: Message[],
  logger: Logger,
): Promise<string | null> {
  if (policy.contactFieldGoal === "none") return null;
  const { store } = deps;

  const wantsPhone = policy.contactFieldGoal === "phone" || policy.contactFieldGoal === "either";
  const wantsEmail = policy.contactFieldGoal === "email" || policy.contactFieldGoal === "either";

  let captured = false;

  if (wantsPhone && !lead.phone) {
    const phone = extractPhone(messages, policy.defaultPhoneRegion);
    if (phone) {
      lead.phone = phone.e164;
      captured = true;
      await store.conversations.recordContactCapture(lead.id, {
        field: "phone",
        value: phone.e164,
        sourceMessageId: phone.sourceMessageId,
        confidence: phone.confidence,
        capturedAt: now(),
      });
      logger.log("contact_captured", { leadId: lead.id, field: "phone", confidence: phone.confidence });
    }
  }
  if (wantsEmail && !lead.email && !captured) {
    const email = extractEmail(messages);
    if (email) {
      lead.email = email.email;
      captured = true;
      await store.conversations.recordContactCapture(lead.id, {
        field: "email",
        value: email.email,
        sourceMessageId: email.sourceMessageId,
        confidence: email.confidence,
        capturedAt: now(),
      });
      logger.log("contact_captured", { leadId: lead.id, field: "email", confidence: email.confidence });
    }
  }

  if (!captured) return null;

  // Advance stage deterministically; confirm; trigger idempotent handoff.
  lead.stage = transition(
    transition(lead.stage, ConversationStage.ContactCaptured),
    ConversationStage.HandoffReady,
  );
  const reply = selectFallback(policy, "contact_captured", messages);
  await appendAssistantMessage(store, lead, reply, "automation");
  lead.lastOutboundAt = now();
  await store.leads.update(lead);

  const stateVersion = `${lead.phone ?? ""}|${lead.email ?? ""}`;
  await triggerHandoff(store, deps.handoff, lead, "contact_captured", stateVersion, logger);

  return reply;
}

function pickSituationalFallback(
  policy: DmCampaignPolicy,
  lead: Lead,
  messages: Message[],
  isFirstTurn: boolean,
): string {
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  if (isFirstTurn || assistantCount === 0) {
    return selectFallback(policy, "generic_first_response", messages);
  }
  const latestUser = [...messages].reverse().find((m) => m.role === "user");
  if (latestUser && isDirectQuestion(latestUser.text)) {
    return selectFallback(policy, "cannot_answer", messages);
  }
  if (lead.stage === ConversationStage.ContactRequested) {
    return selectFallback(policy, "clarification", messages);
  }
  return selectFallback(policy, "clarification", messages);
}

function finish(
  logger: Logger,
  started: number,
  lead: Lead,
  stageBefore: ConversationStage,
  stageAfter: ConversationStage,
  reply: string | null,
  decision: string,
  suppressed: boolean,
): PipelineOutcome {
  logger.log("pipeline_complete", {
    leadId: lead.id,
    decision,
    stageBefore,
    stageAfter,
    replyLength: reply?.length ?? 0,
    latencyMs: Date.now() - started,
    preview: preview(reply),
  });
  return { reply, leadId: lead.id, stageBefore, stageAfter, decision, suppressed };
}
