import type {
  ContactCaptureRecord,
  HandoffJob,
  Lead,
  Message,
  OptOutEvent,
} from "../domain/types.js";
import { KeyedMutex } from "../app/conversationLock.js";
import type {
  ConversationRepository,
  HandoffRepository,
  IdempotencyRepository,
  LeadRepository,
  Store,
} from "./types.js";

/**
 * In-memory store. FOR TESTS AND LOCAL DEVELOPMENT ONLY — production uses
 * the SQLite store on a persistent volume (SQLITE_PATH).
 */
export class MemoryStore implements Store {
  leads: LeadRepository;
  conversations: ConversationRepository;
  idempotency: IdempotencyRepository;
  handoffs: HandoffRepository;

  private mutex = new KeyedMutex();
  private leadRows = new Map<string, Lead>();
  private messageRows: Message[] = [];
  private captures = new Map<string, ContactCaptureRecord[]>();
  private optOuts: OptOutEvent[] = [];
  private idemKeys = new Map<string, number>(); // key -> expiry epoch ms
  private handoffRows = new Map<string, HandoffJob>();

  constructor() {
    const self = this;

    this.leads = {
      async findByExternalId(platform, externalUserId) {
        for (const l of self.leadRows.values()) {
          if (l.platform === platform && l.externalUserId === externalUserId) return { ...l };
        }
        return null;
      },
      async findByAlias(platform, alias) {
        for (const l of self.leadRows.values()) {
          if (l.platform !== platform) continue;
          if (l.externalUserId === alias || l.username === alias || l.aliases.includes(alias)) {
            return { ...l };
          }
        }
        return null;
      },
      async create(lead) {
        self.leadRows.set(lead.id, { ...lead });
        return { ...lead };
      },
      async update(lead) {
        self.leadRows.set(lead.id, { ...lead, updatedAt: new Date().toISOString() });
        return { ...self.leadRows.get(lead.id)! };
      },
      async get(id) {
        const l = self.leadRows.get(id);
        return l ? { ...l } : null;
      },
      async list(limit = 100, offset = 0) {
        return [...self.leadRows.values()]
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
          .slice(offset, offset + limit)
          .map((l) => ({ ...l }));
      },
      async count() {
        return self.leadRows.size;
      },
    };

    this.conversations = {
      async appendMessage(message) {
        self.messageRows.push({ ...message });
        return { ...message };
      },
      async getMessages(leadId, limit = 200) {
        return self.messageRows
          .filter((m) => m.leadId === leadId)
          .slice(-limit)
          .map((m) => ({ ...m }));
      },
      async getLatestMessage(leadId) {
        const msgs = self.messageRows.filter((m) => m.leadId === leadId);
        return msgs.length ? { ...msgs[msgs.length - 1]! } : null;
      },
      async countAssistantMessages(leadId) {
        return self.messageRows.filter(
          (m) => m.leadId === leadId && m.role === "assistant",
        ).length;
      },
      async recordContactCapture(leadId, record) {
        const arr = self.captures.get(leadId) ?? [];
        arr.push({ ...record });
        self.captures.set(leadId, arr);
      },
      async getContactCaptures(leadId) {
        return (self.captures.get(leadId) ?? []).map((c) => ({ ...c }));
      },
      async recordOptOut(event) {
        self.optOuts.push({ ...event });
      },
      async countMessages(excludeLeadPrefix?: string) {
        let excluded: Set<string> | null = null;
        if (excludeLeadPrefix) {
          excluded = new Set(
            [...self.leadRows.values()]
              .filter((l) => l.externalUserId.startsWith(excludeLeadPrefix))
              .map((l) => l.id),
          );
        }
        let user = 0;
        let assistant = 0;
        for (const m of self.messageRows) {
          if (excluded?.has(m.leadId)) continue;
          if (m.role === "user") user++;
          else assistant++;
        }
        return { user, assistant };
      },
    };

    this.idempotency = {
      async claim(key, ttlSeconds) {
        const now = Date.now();
        const existing = self.idemKeys.get(key);
        if (existing !== undefined && existing > now) return false;
        self.idemKeys.set(key, now + ttlSeconds * 1000);
        // Opportunistic cleanup.
        if (self.idemKeys.size > 10000) {
          for (const [k, exp] of self.idemKeys) if (exp <= now) self.idemKeys.delete(k);
        }
        return true;
      },
      async release(key) {
        self.idemKeys.delete(key);
      },
    };

    this.handoffs = {
      async enqueue(job) {
        for (const j of self.handoffRows.values()) {
          if (j.idempotencyKey === job.idempotencyKey) return null;
        }
        self.handoffRows.set(job.id, { ...job });
        return { ...job };
      },
      async markCompleted(id) {
        const j = self.handoffRows.get(id);
        if (j) self.handoffRows.set(id, { ...j, status: "completed", updatedAt: new Date().toISOString() });
      },
      async markFailed(id) {
        const j = self.handoffRows.get(id);
        if (j) {
          self.handoffRows.set(id, {
            ...j,
            status: "pending",
            attempts: j.attempts + 1,
            updatedAt: new Date().toISOString(),
          });
        }
      },
      async pending(limit = 50) {
        return [...self.handoffRows.values()]
          .filter((j) => j.status === "pending")
          .slice(0, limit)
          .map((j) => ({ ...j }));
      },
    };
  }

  withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(key, fn);
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
