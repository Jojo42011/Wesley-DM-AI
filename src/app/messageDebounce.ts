/**
 * Rapid-message batching.
 *
 * WHY. People do not send one tidy message. They send "hey", then "saw your
 * video", then "im looking in round rock" across four seconds. Answering each
 * one separately produces three replies to what was really one thought, and the
 * second and third are written without knowing the rest was coming. Batching
 * turns that burst into a single turn and a single coherent response.
 *
 * WHAT THIS IS PORTED FROM, and where it deliberately differs. Marco's
 * messageDebounce.ts establishes the behaviour: a four second quiet window per
 * user, one combined payload, and only the last waiter in a burst carries the
 * reply so the transport sends once. That much is reproduced here.
 *
 * It also had one property that is wrong for a transport that sends its own
 * replies: when a burst arrived while a previous batch was still being
 * processed, the new batch was resolved empty and its messages were DROPPED.
 * Under ManyChat that merely lost a reply. Here it would lose the lead's actual
 * message, and Wesley's dedupe would then refuse to reprocess it. So a batch
 * that lands mid-turn is QUEUED instead: it waits for the in-flight turn to
 * finish, then flushes as its own turn. Nothing is discarded.
 *
 * WHAT IT DOES NOT DO. It does not serialize anything by itself. The pipeline's
 * per-conversation lock still owns that. This only decides what counts as one
 * turn.
 */
import type { InboundEvent, PipelineOutcome } from "../domain/types.js";

export const DEFAULT_DEBOUNCE_MS = 4000;

export interface BatchResult {
  /**
   * The pipeline outcome, but only for the submission that leads the batch.
   * Every other submission in the same batch gets null, which the caller must
   * treat as "send nothing" — the leader's reply already answers all of them.
   */
  outcome: PipelineOutcome | null;
  leader: boolean;
  /** How many inbound messages were folded into the turn this belongs to. */
  batched: number;
  /**
   * Provider message ids of every message in the batch, leader last. Kept so
   * the caller can record the non-leader ids as processed and so an audit can
   * tie one outbound back to all the inbound it answered.
   */
  providerMessageIds: string[];
}

export type BatchProcessor = (
  combined: InboundEvent,
  parts: InboundEvent[],
) => Promise<PipelineOutcome>;

interface Waiter {
  resolve: (r: BatchResult) => void;
  reject: (err: unknown) => void;
}

interface PendingBatch {
  events: InboundEvent[];
  waiters: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Fold a burst into the single event the pipeline will see.
 *
 * The texts are joined with newlines in arrival order, which is what the person
 * actually typed. Identity comes from the newest message, since a display name
 * can change mid-burst. The provider message id is the newest one too, so the
 * pipeline's durable dedupe claims the last id of the burst; the earlier ids are
 * claimed separately by the caller from `providerMessageIds`.
 */
export function combineEvents(events: InboundEvent[]): InboundEvent {
  const last = events[events.length - 1]!;
  const message = events
    .map((e) => e.message.trim())
    .filter(Boolean)
    .join("\n");
  /* The manual opener is a property of the thread, not of any one message, so
     the first one that carries it wins even if a later message does not. */
  const opener = events.find((e) => e.wesleyPreviousOutbound?.trim())?.wesleyPreviousOutbound ?? null;
  return {
    ...last,
    message,
    wesleyPreviousOutbound: opener ?? last.wesleyPreviousOutbound,
  };
}

export class InboundBatcher {
  private readonly waitMs: number;
  private readonly process: BatchProcessor;
  private readonly pending = new Map<string, PendingBatch>();
  /** Keys with a turn currently running, so arrivals queue instead of racing. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(opts: { process: BatchProcessor; waitMs?: number }) {
    this.process = opts.process;
    this.waitMs = opts.waitMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Add a message to its conversation's batch. Resolves when the batch this
   * message belongs to has been processed.
   */
  submit(key: string, event: InboundEvent): Promise<BatchResult> {
    return new Promise<BatchResult>((resolve, reject) => {
      let batch = this.pending.get(key);
      if (!batch) {
        batch = { events: [], waiters: [], timer: null };
        this.pending.set(key, batch);
      }
      batch.events.push(event);
      batch.waiters.push({ resolve, reject });

      /* Each new message restarts the quiet window, so a steady stream is one
         turn rather than one turn every four seconds. */
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = setTimeout(() => {
        void this.flush(key);
      }, this.waitMs);
      /* Never hold the process open for a debounce timer. */
      batch.timer.unref?.();
    });
  }

  /** Pending message count for a key. Tests and the status route use this. */
  pendingCount(key: string): number {
    return this.pending.get(key)?.events.length ?? 0;
  }

  private async flush(key: string): Promise<void> {
    /* A turn for this conversation is already running. Leave the batch pending
       and disarm its timer: the running turn re-arms it on the way out, so
       these messages become the NEXT turn instead of being dropped. Disarming
       rather than leaving a spent timer in place is what makes that re-arm
       fire, since the re-arm only touches a batch with no live timer. */
    if (this.inFlight.has(key)) {
      const still = this.pending.get(key);
      if (still?.timer) {
        clearTimeout(still.timer);
        still.timer = null;
      }
      return;
    }

    const batch = this.pending.get(key);
    if (!batch || batch.events.length === 0) return;
    this.pending.delete(key);
    if (batch.timer) clearTimeout(batch.timer);

    const run = this.runBatch(batch);
    this.inFlight.set(key, run);
    try {
      await run;
    } finally {
      this.inFlight.delete(key);
      /* Anything that arrived while this turn ran is now the next turn. */
      const next = this.pending.get(key);
      if (next && next.events.length > 0 && !next.timer) {
        next.timer = setTimeout(() => {
          void this.flush(key);
        }, this.waitMs);
        next.timer.unref?.();
      }
    }
  }

  private async runBatch(batch: PendingBatch): Promise<void> {
    const parts = batch.events;
    const waiters = batch.waiters;
    const leader = waiters[waiters.length - 1]!;
    const providerMessageIds = parts
      .map((e) => e.providerMessageId)
      .filter((id): id is string => Boolean(id));

    try {
      const outcome = await this.process(combineEvents(parts), parts);
      for (const w of waiters) {
        w.resolve({
          outcome: w === leader ? outcome : null,
          leader: w === leader,
          batched: parts.length,
          providerMessageIds,
        });
      }
    } catch (err) {
      /* One failure fails the whole turn for everyone in it. The caller logs
         and gives up on this batch rather than sending a partial answer. */
      for (const w of waiters) w.reject(err);
    }
  }
}
