import type {
  ContactCaptureRecord,
  HandoffJob,
  Lead,
  Message,
  OptOutEvent,
} from "../domain/types.js";

export interface LeadRepository {
  findByExternalId(platform: string, externalUserId: string): Promise<Lead | null>;
  /** Also matches aliases so a renamed user does not create a duplicate lead. */
  findByAlias(platform: string, alias: string): Promise<Lead | null>;
  create(lead: Lead): Promise<Lead>;
  update(lead: Lead): Promise<Lead>;
  get(id: string): Promise<Lead | null>;
  list(limit?: number, offset?: number): Promise<Lead[]>;
  count(): Promise<number>;
}

export interface ConversationRepository {
  appendMessage(message: Message): Promise<Message>;
  getMessages(leadId: string, limit?: number): Promise<Message[]>;
  /** Latest message regardless of role. */
  getLatestMessage(leadId: string): Promise<Message | null>;
  countAssistantMessages(leadId: string): Promise<number>;
  recordContactCapture(leadId: string, record: ContactCaptureRecord): Promise<void>;
  getContactCaptures(leadId: string): Promise<ContactCaptureRecord[]>;
  recordOptOut(event: OptOutEvent): Promise<void>;
  /** Message totals; leads whose externalUserId starts with excludeLeadPrefix are skipped. */
  countMessages(excludeLeadPrefix?: string): Promise<{ user: number; assistant: number }>;
}

export interface IdempotencyRepository {
  /**
   * Marks a key processed. Returns true if the key was NEW (caller should
   * process), false if it was already seen (duplicate — skip).
   */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface HandoffRepository {
  enqueue(job: HandoffJob): Promise<HandoffJob | null>; // null if idempotency key exists
  markCompleted(id: string): Promise<void>;
  markFailed(id: string): Promise<void>;
  pending(limit?: number): Promise<HandoffJob[]>;
}

export interface Store {
  leads: LeadRepository;
  conversations: ConversationRepository;
  idempotency: IdempotencyRepository;
  handoffs: HandoffRepository;
  /**
   * Runs fn while holding an exclusive lock for the conversation key.
   * Callers queue; distinct messages are serialized, never dropped.
   */
  withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
