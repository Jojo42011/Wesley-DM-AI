import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * LLM integration. The pipeline depends only on the LlmClient interface —
 * tests use FakeLlm, production uses AnthropicLlm (low-latency model,
 * configurable via ANTHROPIC_MODEL; defaults to Claude Haiku for speed as
 * the campaign spec requires).
 *
 * Every call returns validated JSON or null — a provider failure NEVER
 * throws out of this module; the pipeline falls back deterministically.
 */

export const IntentGateSchema = z.object({
  interested: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const PreflightSchema = z.object({
  userRepeated: z.boolean(),
  wesleyRepeated: z.boolean(),
  sentiment: z.enum(["positive", "neutral", "confused", "skeptical", "resistant", "upset"]),
  unansweredQuestions: z.array(z.string()),
  closedTopics: z.array(z.string()),
  nextObjective: z.string(),
  coachingNote: z.string(),
  shouldReply: z.boolean(),
  shouldEscalate: z.boolean(),
});

export const ReplySchema = z.object({
  reply: z.string().nullable(),
  needs_human: z.boolean(),
  reason: z.string(),
});

export type IntentGateOutput = z.infer<typeof IntentGateSchema>;
export type PreflightOutput = z.infer<typeof PreflightSchema>;
export type ReplyOutput = z.infer<typeof ReplySchema>;

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmClient {
  /** Returns validated JSON matching the zod schema, or null on any failure. */
  completeJson<T>(
    req: LlmRequest,
    schema: z.ZodType<T>,
    jsonSchema: Record<string, unknown>,
  ): Promise<T | null>;
}

/* ---------------------------------- JSON schemas (for structured outputs) */

export const INTENT_GATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    interested: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["interested", "confidence", "reason"],
  additionalProperties: false,
};

export const PREFLIGHT_JSON_SCHEMA = {
  type: "object",
  properties: {
    userRepeated: { type: "boolean" },
    wesleyRepeated: { type: "boolean" },
    sentiment: {
      type: "string",
      enum: ["positive", "neutral", "confused", "skeptical", "resistant", "upset"],
    },
    unansweredQuestions: { type: "array", items: { type: "string" } },
    closedTopics: { type: "array", items: { type: "string" } },
    nextObjective: { type: "string" },
    coachingNote: { type: "string" },
    shouldReply: { type: "boolean" },
    shouldEscalate: { type: "boolean" },
  },
  required: [
    "userRepeated", "wesleyRepeated", "sentiment", "unansweredQuestions",
    "closedTopics", "nextObjective", "coachingNote", "shouldReply", "shouldEscalate",
  ],
  additionalProperties: false,
};

export const REPLY_JSON_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: ["string", "null"] },
    needs_human: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["reply", "needs_human", "reason"],
  additionalProperties: false,
};

/* ----------------------------------------------------------- Anthropic */

export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.client = new Anthropic(opts?.apiKey ? { apiKey: opts.apiKey } : {});
    // Low-latency conversation model per campaign requirements; configurable.
    this.model = opts?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
  }

  async completeJson<T>(
    req: LlmRequest,
    schema: z.ZodType<T>,
    jsonSchema: Record<string, unknown>,
  ): Promise<T | null> {
    try {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: this.model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: {
          format: { type: "json_schema", schema: jsonSchema },
        },
      };
      const response = await this.client.messages.create(params);

      if (response.stop_reason === "refusal") return null;
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") return null;
      const parsed = schema.safeParse(JSON.parse(text.text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

/* --------------------------------------------------------------- Fake */

/**
 * Deterministic fake for tests. Queue responses per call or set defaults.
 */
export class FakeLlm implements LlmClient {
  public calls: LlmRequest[] = [];
  private queue: Array<unknown | Error> = [];
  private defaultResponse: unknown | Error | null = null;
  /** Optional dispatcher — receives the request, returns raw JSON or null. */
  public handler: ((req: LlmRequest) => unknown | Error | null) | null = null;

  enqueue(response: unknown | Error): void {
    this.queue.push(response);
  }

  setDefault(response: unknown | Error | null): void {
    this.defaultResponse = response;
  }

  async completeJson<T>(
    req: LlmRequest,
    schema: z.ZodType<T>,
    _jsonSchema: Record<string, unknown>,
  ): Promise<T | null> {
    this.calls.push(req);
    let next: unknown | Error | null;
    if (this.queue.length) next = this.queue.shift()!;
    else if (this.handler) next = this.handler(req);
    else next = this.defaultResponse;
    if (next === null || next === undefined) return null;
    if (next instanceof Error) return null; // provider failure → safe null
    const parsed = schema.safeParse(next);
    return parsed.success ? parsed.data : null; // invalid JSON → rejected
  }
}
