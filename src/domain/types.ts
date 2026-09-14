/**
 * Core domain types for the TikTok DM automation.
 * Everything client-specific (business facts, CTAs, claims) lives in campaign
 * configuration — never in these types or the pipeline code.
 */

export enum ConversationStage {
  New = "new",
  ClarificationPending = "clarification_pending",
  ValueOffered = "value_offered",
  ContactRequested = "contact_requested",
  ContactCaptured = "contact_captured",
  Qualification = "qualification",
  HandoffReady = "handoff_ready",
  FollowUpDue = "follow_up_due",
  HumanReview = "human_review",
  Closed = "closed",
}

export interface Lead {
  id: string;
  platform: "tiktok";
  externalUserId: string;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  stage: ConversationStage;
  sourceCampaign: string | null;
  conversationGoal: string;
  qualification: Record<string, unknown>;
  tags: string[];
  notes: string | null;
  /** Aliases seen for this user (old usernames etc.) so renames don't duplicate leads. */
  aliases: string[];
  /** Automation suppressed (opt-out). */
  optedOut: boolean;
  createdAt: string;
  updatedAt: string;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
}

/**
 * Where a stored message came from.
 *
 * `tiktok_manychat` is the ManyChat connector and the testing simulator that
 * speaks its payload shape. `tiktok_zernio` is the Zernio inbox, which is the
 * live TikTok transport. Both are kept: rows written before the Zernio cutover
 * are accurate as they stand and are not rewritten, so the label says which
 * transport actually carried that message rather than which one is current.
 */
export type MessageSource = "tiktok_manychat" | "tiktok_zernio" | "manual_seed" | "automation";

export interface Message {
  id: string;
  leadId: string;
  role: "user" | "assistant";
  text: string;
  providerMessageId: string | null;
  source: MessageSource;
  createdAt: string;
}

export interface ContactCaptureRecord {
  field: "phone" | "email";
  value: string;
  sourceMessageId: string | null;
  confidence: number;
  capturedAt: string;
}

export interface OptOutEvent {
  leadId: string;
  messageText: string;
  occurredAt: string;
}

export interface HandoffJob {
  id: string;
  leadId: string;
  type: string;
  idempotencyKey: string;
  status: "pending" | "completed" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface QualificationField {
  key: string;
  question: string;
  required: boolean;
}

export interface EscalationRule {
  key: string;
  description: string;
  /** Regex patterns (case-insensitive) that trigger this rule deterministically. */
  patterns: string[];
}

export interface SilenceRule {
  key: string;
  description: string;
  /** When true, prefer no reply in the matched situation. */
  preferSilence: boolean;
}

export type FallbackKind =
  | "generic_first_response"
  | "clarification"
  | "direct_question_ack"
  | "cta_request"
  | "cta_resistance"
  | "contact_captured"
  | "info_already_sent"
  | "cannot_answer"
  | "human_handoff"
  | "closeout";

export type FallbackResponseSet = Record<FallbackKind, string[]>;

export interface PinnedAnswer {
  /** Regex patterns (case-insensitive) matching a direct question. */
  patterns: string[];
  answer: string;
}

export interface DmCampaignPolicy {
  key: string;
  objective: string;
  valueProposition: string;
  primaryCallToAction: string;
  contactFieldGoal: "phone" | "email" | "either" | "none";
  maxReplyCharacters: number;
  maxSentences: number;
  allowedClaims: string[];
  prohibitedClaims: string[];
  requiredDisclosures: string[];
  qualificationFields: QualificationField[];
  escalationRules: EscalationRule[];
  silenceRules: SilenceRule[];
  fallbackResponses: FallbackResponseSet;
  /** Policy-approved pinned answers for common direct questions. */
  pinnedAnswers: PinnedAnswer[];
  /** Confirm opt-out once with this message (empty = silent opt-out). */
  optOutConfirmation: string;
  /** Default phone region for extraction, e.g. "US". */
  defaultPhoneRegion: string;
}

export interface VoiceExample {
  id: string;
  thread: Array<{ role: "user" | "assistant"; text: string }>;
  targetResponse: string;
  situation: string;
  userIntent: string;
  sentiment: string;
  stage: ConversationStage;
  objectionType: string | null;
  outcome: string | null;
  approved: boolean;
  qualityScore: number;
}

export interface VoiceProfile {
  averageMessageLength: number;
  averageSentenceLength: number;
  greetingHabits: string[];
  punctuationPatterns: string[];
  capitalizationStyle: string;
  emojiFrequency: "none" | "rare" | "occasional" | "frequent";
  emojisUsed: string[];
  commonPhrases: string[];
  directnessNotes: string;
  resistanceHandling: string;
  ctaTransitions: string[];
  followUpStyle: string;
  neverUses: string[];
  enthusiasmBySentiment: Record<string, string>;
}

export type Sentiment =
  | "positive"
  | "neutral"
  | "confused"
  | "skeptical"
  | "resistant"
  | "upset";

export interface PreflightResult {
  userRepeated: boolean;
  wesleyRepeated: boolean;
  sentiment: Sentiment;
  unansweredQuestions: string[];
  closedTopics: string[];
  nextObjective: string;
  coachingNote: string;
  shouldReply: boolean;
  shouldEscalate: boolean;
}

export interface IntentGateResult {
  interested: boolean;
  confidence: number;
  reason: string;
}

export interface InboundEvent {
  platform: "tiktok";
  externalUserId: string;
  username: string | null;
  displayName: string | null;
  message: string;
  providerMessageId: string | null;
  wesleyPreviousOutbound: string | null;
  conversationGoal: string | null;
  sourceCampaign: string | null;
  flowKey: string | null;
  isEcho: boolean;
  /**
   * Which transport delivered this message, used only to label the stored row.
   * Optional so every existing caller and test stays valid; absent means the
   * ManyChat-shaped path, which is what it was before Zernio existed.
   */
  transport?: Extract<MessageSource, "tiktok_manychat" | "tiktok_zernio">;
}

export interface PipelineOutcome {
  reply: string | null;
  leadId: string | null;
  stageBefore: ConversationStage | null;
  stageAfter: ConversationStage | null;
  decision: string;
  suppressed: boolean;
}
