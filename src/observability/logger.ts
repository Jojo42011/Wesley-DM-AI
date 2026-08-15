import { randomUUID } from "node:crypto";

/**
 * Structured JSON logging with request + conversation correlation IDs.
 * Never log full contact details, API keys, or unredacted message bodies.
 */

export type LogEvent =
  | "inbound_accepted"
  | "inbound_rejected"
  | "manual_opener_seeded"
  | "intent_gate"
  | "message_appended"
  | "deterministic_guard"
  | "preflight_complete"
  | "contact_captured"
  | "reply_generated"
  | "reply_rejected"
  | "reply_retried"
  | "reply_fallback"
  | "reply_suppressed"
  | "handoff_queued"
  | "handoff_completed"
  | "handoff_failed"
  | "opt_out"
  | "escalation"
  | "pipeline_complete"
  | "pipeline_error"
  | "server_started";

export interface LogContext {
  requestId: string;
  conversationId?: string;
  [key: string]: unknown;
}

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/\+?\d[\d\s().-]{7,}\d/g, "[phone]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, sub] of REDACT_PATTERNS) out = out.replace(re, sub);
  return out;
}

/** Short redacted preview for logs. */
export function preview(text: string | null | undefined, max = 60): string {
  if (!text) return "";
  const r = redact(text);
  return r.length > max ? `${r.slice(0, max)}…` : r;
}

export interface Logger {
  log(event: LogEvent, fields?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): Logger;
}

let sink: (line: string) => void = (line) => process.stdout.write(line + "\n");

/** Tests can swap the sink to keep output quiet or capture logs. */
export function setLogSink(fn: (line: string) => void): void {
  sink = fn;
}

class JsonLogger implements Logger {
  constructor(private readonly ctx: Record<string, unknown>) {}

  log(event: LogEvent, fields: Record<string, unknown> = {}): void {
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        ...this.ctx,
        ...fields,
      }),
    );
  }

  child(extra: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.ctx, ...extra });
  }
}

export function createLogger(ctx?: Partial<LogContext>): Logger {
  return new JsonLogger({ requestId: ctx?.requestId ?? randomUUID(), ...ctx });
}
