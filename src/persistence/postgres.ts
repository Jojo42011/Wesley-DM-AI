import pg from "pg";
import { createHash } from "node:crypto";
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
  qualification JSONB NOT NULL DEFAULT '{}',
  tags JSONB NOT NULL DEFAULT '[]',
  notes TEXT,
  aliases JSONB NOT NULL DEFAULT '[]',
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_inbound_at TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  UNIQUE (platform, external_user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  provider_message_id TEXT,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id, created_at);
CREATE TABLE IF NOT EXISTS contact_captures (
  lead_id TEXT NOT NULL REFERENCES leads(id),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  source_message_id TEXT,
  confidence DOUBLE PRECISION NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS opt_outs (
  lead_id TEXT NOT NULL,
  message_text TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_events (
  key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff_jobs (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`;

function rowToLead(r: Record<string, unknown>): Lead {
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
    qualification: (r.qualification as Record<string, unknown>) ?? {},
    tags: (r.tags as string[]) ?? [],
    notes: (r.notes as string) ?? null,
    aliases: (r.aliases as string[]) ?? [],
    optedOut: Boolean(r.opted_out),
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
    lastInboundAt: r.last_inbound_at ? (r.last_inbound_at as Date).toISOString() : null,
    lastOutboundAt: r.last_outbound_at ? (r.last_outbound_at as Date).toISOString() : null,
  };
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as string,
    leadId: r.lead_id as string,
    role: r.role as "user" | "assistant",
    text: r.text as string,
    providerMessageId: (r.provider_message_id as string) ?? null,
    source: r.source as Message["source"],
    createdAt: (r.created_at as Date).toISOString(),
  };
}

export class PostgresStore implements Store {
  leads: LeadRepository;
  conversations: ConversationRepository;
  idempotency: IdempotencyRepository;
  handoffs: HandoffRepository;

  private pool: pg.Pool;
  private localMutex = new KeyedMutex();

  private constructor(pool: pg.Pool) {
    this.pool = pool;
    const q = (text: string, values?: unknown[]) => pool.query(text, values);

    this.leads = {
      async findByExternalId(platform, externalUserId) {
        const res = await q(
          "SELECT * FROM leads WHERE platform=$1 AND external_user_id=$2",
          [platform, externalUserId],
        );
        return res.rows[0] ? rowToLead(res.rows[0]) : null;
      },
      async findByAlias(platform, alias) {
        const res = await q(
          `SELECT * FROM leads WHERE platform=$1 AND
             (external_user_id=$2 OR username=$2 OR aliases @> to_jsonb(ARRAY[$2]::text[]))`,
          [platform, alias],
        );
        return res.rows[0] ? rowToLead(res.rows[0]) : null;
      },
      async create(lead) {
        await q(
          `INSERT INTO leads (id, platform, external_user_id, username, display_name, phone, email,
             stage, source_campaign, conversation_goal, qualification, tags, notes, aliases, opted_out,
             created_at, updated_at, last_inbound_at, last_outbound_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [
            lead.id, lead.platform, lead.externalUserId, lead.username, lead.displayName,
            lead.phone, lead.email, lead.stage, lead.sourceCampaign, lead.conversationGoal,
            JSON.stringify(lead.qualification), JSON.stringify(lead.tags), lead.notes,
            JSON.stringify(lead.aliases), lead.optedOut, lead.createdAt, lead.updatedAt,
            lead.lastInboundAt, lead.lastOutboundAt,
          ],
        );
        return lead;
      },
      async update(lead) {
        const updatedAt = new Date().toISOString();
        await q(
          `UPDATE leads SET username=$2, display_name=$3, phone=$4, email=$5, stage=$6,
             source_campaign=$7, conversation_goal=$8, qualification=$9, tags=$10, notes=$11,
             aliases=$12, opted_out=$13, updated_at=$14, last_inbound_at=$15, last_outbound_at=$16
           WHERE id=$1`,
          [
            lead.id, lead.username, lead.displayName, lead.phone, lead.email, lead.stage,
            lead.sourceCampaign, lead.conversationGoal, JSON.stringify(lead.qualification),
            JSON.stringify(lead.tags), lead.notes, JSON.stringify(lead.aliases), lead.optedOut,
            updatedAt, lead.lastInboundAt, lead.lastOutboundAt,
          ],
        );
        return { ...lead, updatedAt };
      },
      async get(id) {
        const res = await q("SELECT * FROM leads WHERE id=$1", [id]);
        return res.rows[0] ? rowToLead(res.rows[0]) : null;
      },
      async list(limit = 100, offset = 0) {
        const res = await q(
          "SELECT * FROM leads ORDER BY created_at DESC LIMIT $1 OFFSET $2",
          [limit, offset],
        );
        return res.rows.map(rowToLead);
      },
      async count() {
        const res = await q("SELECT COUNT(*)::int AS n FROM leads");
        return res.rows[0].n as number;
      },
    };

    this.conversations = {
      async appendMessage(message) {
        await q(
          `INSERT INTO messages (id, lead_id, role, text, provider_message_id, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            message.id, message.leadId, message.role, message.text,
            message.providerMessageId, message.source, message.createdAt,
          ],
        );
        return message;
      },
      async getMessages(leadId, limit = 200) {
        const res = await q(
          `SELECT * FROM (
             SELECT * FROM messages WHERE lead_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2
           ) sub ORDER BY created_at ASC, id ASC`,
          [leadId, limit],
        );
        return res.rows.map(rowToMessage);
      },
      async getLatestMessage(leadId) {
        const res = await q(
          "SELECT * FROM messages WHERE lead_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1",
          [leadId],
        );
        return res.rows[0] ? rowToMessage(res.rows[0]) : null;
      },
      async countAssistantMessages(leadId) {
        const res = await q(
          "SELECT COUNT(*)::int AS n FROM messages WHERE lead_id=$1 AND role='assistant'",
          [leadId],
        );
        return res.rows[0].n as number;
      },
      async recordContactCapture(leadId, record) {
        await q(
          `INSERT INTO contact_captures (lead_id, field, value, source_message_id, confidence, captured_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [leadId, record.field, record.value, record.sourceMessageId, record.confidence, record.capturedAt],
        );
      },
      async getContactCaptures(leadId) {
        const res = await q("SELECT * FROM contact_captures WHERE lead_id=$1", [leadId]);
        return res.rows.map((r) => ({
          field: r.field as ContactCaptureRecord["field"],
          value: r.value as string,
          sourceMessageId: (r.source_message_id as string) ?? null,
          confidence: r.confidence as number,
          capturedAt: (r.captured_at as Date).toISOString(),
        }));
      },
      async recordOptOut(event: OptOutEvent) {
        await q(
          "INSERT INTO opt_outs (lead_id, message_text, occurred_at) VALUES ($1,$2,$3)",
          [event.leadId, event.messageText, event.occurredAt],
        );
      },
      async countMessages(excludeLeadPrefix?: string) {
        const res = excludeLeadPrefix
          ? await q(
              `SELECT m.role, COUNT(*)::int AS n FROM messages m
               JOIN leads l ON l.id = m.lead_id
               WHERE l.external_user_id NOT LIKE $1 GROUP BY m.role`,
              [`${excludeLeadPrefix.replace(/[\\%_]/g, "\\$&")}%`],
            )
          : await q("SELECT role, COUNT(*)::int AS n FROM messages GROUP BY role");
        let user = 0;
        let assistant = 0;
        for (const r of res.rows) {
          if (r.role === "user") user = r.n;
          else assistant = r.n;
        }
        return { user, assistant };
      },
    };

    this.idempotency = {
      async claim(key, ttlSeconds) {
        // Best-effort cleanup then atomic claim.
        await q("DELETE FROM processed_events WHERE expires_at < now()");
        const res = await q(
          `INSERT INTO processed_events (key, expires_at)
           VALUES ($1, now() + make_interval(secs => $2))
           ON CONFLICT (key) DO NOTHING`,
          [key, ttlSeconds],
        );
        return (res.rowCount ?? 0) > 0;
      },
    };

    this.handoffs = {
      async enqueue(job: HandoffJob) {
        const res = await q(
          `INSERT INTO handoff_jobs (id, lead_id, type, idempotency_key, status, attempts, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (idempotency_key) DO NOTHING`,
          [job.id, job.leadId, job.type, job.idempotencyKey, job.status, job.attempts, job.createdAt, job.updatedAt],
        );
        return (res.rowCount ?? 0) > 0 ? job : null;
      },
      async markCompleted(id) {
        await q("UPDATE handoff_jobs SET status='completed', updated_at=now() WHERE id=$1", [id]);
      },
      async markFailed(id) {
        await q(
          "UPDATE handoff_jobs SET status='pending', attempts=attempts+1, updated_at=now() WHERE id=$1",
          [id],
        );
      },
      async pending(limit = 50) {
        const res = await q(
          "SELECT * FROM handoff_jobs WHERE status='pending' ORDER BY created_at LIMIT $1",
          [limit],
        );
        return res.rows.map((r) => ({
          id: r.id as string,
          leadId: r.lead_id as string,
          type: r.type as string,
          idempotencyKey: r.idempotency_key as string,
          status: r.status as HandoffJob["status"],
          attempts: r.attempts as number,
          createdAt: (r.created_at as Date).toISOString(),
          updatedAt: (r.updated_at as Date).toISOString(),
        }));
      },
    };
  }

  static async connect(connectionString: string): Promise<PostgresStore> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query(SCHEMA);
    return new PostgresStore(pool);
  }

  async withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Local FIFO queue first (fairness within instance), then a pg advisory
    // lock so multiple instances serialize on the same conversation.
    return this.localMutex.run(key, async () => {
      const client = await this.pool.connect();
      const lockId = BigInt.asIntN(
        64,
        BigInt("0x" + createHash("sha256").update(key).digest("hex").slice(0, 16)),
      );
      try {
        await client.query("SELECT pg_advisory_lock($1)", [lockId.toString()]);
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId.toString()]).catch(() => {});
        client.release();
      }
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
