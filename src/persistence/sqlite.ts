import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  ContactCaptureRecord,
  HandoffJob,
  Lead,
  Message,
  OptOutEvent,
} from "../domain/types.js";
import { ConversationStage } from "../domain/types.js";
import { KeyedMutex } from "../app/conversationLock.js";
import type {
  ConversationRepository,
  HandoffRepository,
  IdempotencyRepository,
  LeadRepository,
  Store,
} from "./types.js";

/**
 * SQLite store — the production source of truth, persisted on a mounted
 * volume (SQLITE_PATH, e.g. /data/wesley.db on Fly). Single-writer, which
 * matches the single-machine deployment; per-conversation ordering comes
 * from the in-process KeyedMutex.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  phone TEXT,
  email TEXT,
  stage TEXT NOT NULL,
  source_campaign TEXT,
  conversation_goal TEXT NOT NULL,
  qualification TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  opted_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  UNIQUE (platform, external_user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  provider_message_id TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at);
CREATE TABLE IF NOT EXISTS contact_captures (
  lead_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  source_message_id TEXT,
  confidence REAL NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS opt_outs (
  lead_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_events (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff_jobs (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function rowToLead(r: Row): Lead {
  return {
    id: r.id as string,
    platform: "tiktok",
    externalUserId: r.external_user_id as string,
    username: (r.username as string) ?? null,
    displayName: (r.display_name as string) ?? null,
    phone: (r.phone as string) ?? null,
    email: (r.email as string) ?? null,
    stage: r.stage as ConversationStage,
    sourceCampaign: (r.source_campaign as string) ?? null,
    conversationGoal: r.conversation_goal as string,
    qualification: JSON.parse(r.qualification as string),
    tags: JSON.parse(r.tags as string),
    notes: (r.notes as string) ?? null,
    aliases: JSON.parse(r.aliases as string),
    optedOut: Boolean(r.opted_out),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    lastInboundAt: (r.last_inbound_at as string) ?? null,
    lastOutboundAt: (r.last_outbound_at as string) ?? null,
  };
}

function rowToMessage(r: Row): Message {
  return {
    id: r.id as string,
    leadId: r.lead_id as string,
    role: r.role as "user" | "assistant",
    text: r.text as string,
    providerMessageId: (r.provider_message_id as string) ?? null,
    source: r.source as Message["source"],
    createdAt: r.created_at as string,
  };
}

export class SqliteStore implements Store {
  leads: LeadRepository;
  conversations: ConversationRepository;
  idempotency: IdempotencyRepository;
  handoffs: HandoffRepository;

  private db: Database.Database;
  private mutex = new KeyedMutex();

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
    const db = this.db;

    this.leads = {
      async findByExternalId(platform, externalUserId) {
        const r = db
          .prepare("SELECT * FROM leads WHERE platform=? AND external_user_id=?")
          .get(platform, externalUserId) as Row | undefined;
        return r ? rowToLead(r) : null;
      },
      async findByAlias(platform, alias) {
        const r = db
          .prepare(
            `SELECT * FROM leads WHERE platform=? AND
               (external_user_id=? OR username=? OR EXISTS (
                 SELECT 1 FROM json_each(leads.aliases) WHERE json_each.value=?))`,
          )
          .get(platform, alias, alias, alias) as Row | undefined;
        return r ? rowToLead(r) : null;
      },
      async create(lead) {
        db.prepare(
          `INSERT INTO leads (id, platform, external_user_id, username, display_name, phone, email,
             stage, source_campaign, conversation_goal, qualification, tags, notes, aliases, opted_out,
             created_at, updated_at, last_inbound_at, last_outbound_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          lead.id, lead.platform, lead.externalUserId, lead.username, lead.displayName,
          lead.phone, lead.email, lead.stage, lead.sourceCampaign, lead.conversationGoal,
          JSON.stringify(lead.qualification), JSON.stringify(lead.tags), lead.notes,
          JSON.stringify(lead.aliases), lead.optedOut ? 1 : 0, lead.createdAt, lead.updatedAt,
          lead.lastInboundAt, lead.lastOutboundAt,
        );
        return lead;
      },
      async update(lead) {
        const updatedAt = new Date().toISOString();
        db.prepare(
          `UPDATE leads SET username=?, display_name=?, phone=?, email=?, stage=?,
             source_campaign=?, conversation_goal=?, qualification=?, tags=?, notes=?,
             aliases=?, opted_out=?, updated_at=?, last_inbound_at=?, last_outbound_at=?
           WHERE id=?`,
        ).run(
          lead.username, lead.displayName, lead.phone, lead.email, lead.stage,
          lead.sourceCampaign, lead.conversationGoal, JSON.stringify(lead.qualification),
          JSON.stringify(lead.tags), lead.notes, JSON.stringify(lead.aliases),
          lead.optedOut ? 1 : 0, updatedAt, lead.lastInboundAt, lead.lastOutboundAt, lead.id,
        );
        return { ...lead, updatedAt };
      },
      async get(id) {
        const r = db.prepare("SELECT * FROM leads WHERE id=?").get(id) as Row | undefined;
        return r ? rowToLead(r) : null;
      },
      async list(limit = 100, offset = 0) {
        const rows = db
          .prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT ? OFFSET ?")
          .all(limit, offset) as Row[];
        return rows.map(rowToLead);
      },
      async count() {
        const r = db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number };
        return r.n;
      },
    };

    this.conversations = {
      async appendMessage(message) {
        db.prepare(
          `INSERT INTO messages (id, lead_id, role, text, provider_message_id, source, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(
          message.id, message.leadId, message.role, message.text,
          message.providerMessageId, message.source, message.createdAt,
        );
        return message;
      },
      async getMessages(leadId, limit = 200) {
        const rows = db
          .prepare(
            `SELECT * FROM (
               SELECT *, rowid AS rid FROM messages WHERE lead_id=? ORDER BY created_at DESC, rid DESC LIMIT ?
             ) ORDER BY created_at ASC, rid ASC`,
          )
          .all(leadId, limit) as Row[];
        return rows.map(rowToMessage);
      },
      async getLatestMessage(leadId) {
        const r = db
          .prepare("SELECT * FROM messages WHERE lead_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get(leadId) as Row | undefined;
        return r ? rowToMessage(r) : null;
      },
      async countAssistantMessages(leadId) {
        const r = db
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE lead_id=? AND role='assistant'")
          .get(leadId) as { n: number };
        return r.n;
      },
      async recordContactCapture(leadId, record) {
        db.prepare(
          `INSERT INTO contact_captures (lead_id, field, value, source_message_id, confidence, captured_at)
           VALUES (?,?,?,?,?,?)`,
        ).run(leadId, record.field, record.value, record.sourceMessageId, record.confidence, record.capturedAt);
      },
      async getContactCaptures(leadId) {
        const rows = db
          .prepare("SELECT * FROM contact_captures WHERE lead_id=?")
          .all(leadId) as Row[];
        return rows.map((r) => ({
          field: r.field as ContactCaptureRecord["field"],
          value: r.value as string,
          sourceMessageId: (r.source_message_id as string) ?? null,
          confidence: r.confidence as number,
          capturedAt: r.captured_at as string,
        }));
      },
      async recordOptOut(event: OptOutEvent) {
        db.prepare("INSERT INTO opt_outs (lead_id, message_text, occurred_at) VALUES (?,?,?)").run(
          event.leadId, event.messageText, event.occurredAt,
        );
      },
      async countMessages(excludeLeadPrefix?: string) {
        const rows = (
          excludeLeadPrefix
            ? db
                .prepare(
                  `SELECT m.role AS role, COUNT(*) AS n FROM messages m
                   JOIN leads l ON l.id = m.lead_id
                   WHERE l.external_user_id NOT LIKE ? ESCAPE '\\' GROUP BY m.role`,
                )
                .all(`${excludeLeadPrefix.replace(/[\\%_]/g, "\\$&")}%`)
            : db.prepare("SELECT role, COUNT(*) AS n FROM messages GROUP BY role").all()
        ) as Array<{ role: string; n: number }>;
        let user = 0;
        let assistant = 0;
        for (const r of rows) {
          if (r.role === "user") user = r.n;
          else assistant = r.n;
        }
        return { user, assistant };
      },
    };

    this.idempotency = {
      async claim(key, ttlSeconds) {
        const now = Date.now();
        db.prepare("DELETE FROM processed_events WHERE expires_at < ?").run(now);
        const res = db
          .prepare("INSERT OR IGNORE INTO processed_events (key, expires_at) VALUES (?,?)")
          .run(key, now + ttlSeconds * 1000);
        return res.changes > 0;
      },
    };

    this.handoffs = {
      async enqueue(job: HandoffJob) {
        const res = db
          .prepare(
            `INSERT OR IGNORE INTO handoff_jobs (id, lead_id, type, idempotency_key, status, attempts, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run(job.id, job.leadId, job.type, job.idempotencyKey, job.status, job.attempts, job.createdAt, job.updatedAt);
        return res.changes > 0 ? job : null;
      },
      async markCompleted(id) {
        db.prepare("UPDATE handoff_jobs SET status='completed', updated_at=? WHERE id=?").run(
          new Date().toISOString(), id,
        );
      },
      async markFailed(id) {
        db.prepare(
          "UPDATE handoff_jobs SET status='pending', attempts=attempts+1, updated_at=? WHERE id=?",
        ).run(new Date().toISOString(), id);
      },
      async pending(limit = 50) {
        const rows = db
          .prepare("SELECT * FROM handoff_jobs WHERE status='pending' ORDER BY created_at LIMIT ?")
          .all(limit) as Row[];
        return rows.map((r) => ({
          id: r.id as string,
          leadId: r.lead_id as string,
          type: r.type as string,
          idempotencyKey: r.idempotency_key as string,
          status: r.status as HandoffJob["status"],
          attempts: r.attempts as number,
          createdAt: r.created_at as string,
          updatedAt: r.updated_at as string,
        }));
      },
    };
  }

  withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(key, fn);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
