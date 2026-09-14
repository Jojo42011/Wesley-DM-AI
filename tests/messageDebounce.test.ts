/**
 * Rapid-message batching.
 *
 * The case worth the most attention is the one Marco's version got wrong: a
 * message arriving while a turn is already running. There it was dropped. Here
 * it has to become the next turn.
 */
import { describe, expect, it } from "vitest";
import { InboundBatcher, combineEvents } from "../src/app/messageDebounce.js";
import type { InboundEvent, PipelineOutcome } from "../src/domain/types.js";
import { makeEvent } from "./helpers.js";

function outcome(reply: string | null): PipelineOutcome {
  return { reply, leadId: "l1", stageBefore: null, stageAfter: null, decision: "test", suppressed: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("combining a burst into one turn", () => {
  it("56. joins the texts in arrival order and keeps the newest identity", () => {
    const combined = combineEvents([
      makeEvent({ message: "hey", displayName: "Old Name", providerMessageId: "m1" }),
      makeEvent({ message: "  saw your video  ", providerMessageId: "m2" }),
      makeEvent({ message: "im in round rock", displayName: "New Name", providerMessageId: "m3" }),
    ]);
    expect(combined.message).toBe("hey\nsaw your video\nim in round rock");
    expect(combined.displayName).toBe("New Name");
    expect(combined.providerMessageId).toBe("m3");
  });

  it("57. keeps the manual opener even when only the first message carried it", () => {
    const combined = combineEvents([
      makeEvent({ message: "hey", wesleyPreviousOutbound: "the VA opener" }),
      makeEvent({ message: "you there?", wesleyPreviousOutbound: null }),
    ]);
    expect(combined.wesleyPreviousOutbound).toBe("the VA opener");
  });

  it("58. drops empty texts rather than leaving blank lines in the turn", () => {
    const combined = combineEvents([
      makeEvent({ message: "hey" }),
      makeEvent({ message: "   " }),
      makeEvent({ message: "you there" }),
    ]);
    expect(combined.message).toBe("hey\nyou there");
  });
});

describe("batching behaviour", () => {
  it("59. a burst runs the pipeline once and only the last submission carries the reply", async () => {
    const seen: InboundEvent[] = [];
    const batcher = new InboundBatcher({
      waitMs: 60,
      process: async (combined) => {
        seen.push(combined);
        return outcome("one answer");
      },
    });

    const results = await Promise.all([
      batcher.submit("k", makeEvent({ message: "a", providerMessageId: "m1" })),
      batcher.submit("k", makeEvent({ message: "b", providerMessageId: "m2" })),
      batcher.submit("k", makeEvent({ message: "c", providerMessageId: "m3" })),
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.message).toBe("a\nb\nc");
    expect(results.filter((r) => r.leader)).toHaveLength(1);
    expect(results.filter((r) => r.outcome !== null)).toHaveLength(1);
    expect(results.at(-1)!.outcome!.reply).toBe("one answer");
    expect(results.at(-1)!.providerMessageIds).toEqual(["m1", "m2", "m3"]);
    expect(results.every((r) => r.batched === 3)).toBe(true);
  });

  it("60. each new message restarts the quiet window instead of cutting the burst short", async () => {
    let turns = 0;
    const batcher = new InboundBatcher({
      waitMs: 80,
      process: async () => {
        turns++;
        return outcome("x");
      },
    });
    const pending = [batcher.submit("k", makeEvent({ message: "a" }))];
    await sleep(50);
    pending.push(batcher.submit("k", makeEvent({ message: "b" })));
    await sleep(50);
    pending.push(batcher.submit("k", makeEvent({ message: "c" })));
    await Promise.all(pending);
    expect(turns).toBe(1);
  });

  it("61. a message arriving MID-TURN is queued as the next turn, never dropped", async () => {
    const seen: string[] = [];
    let release: (() => void) | null = null;
    const firstTurnStarted = new Promise<void>((resolve) => {
      release = resolve;
    });

    const batcher = new InboundBatcher({
      waitMs: 30,
      process: async (combined) => {
        seen.push(combined.message);
        if (seen.length === 1) {
          release?.();
          /* Hold the first turn open long enough for the next message to
             arrive and for its debounce timer to fire while we are busy. */
          await sleep(150);
        }
        return outcome("answer");
      },
    });

    const first = batcher.submit("k", makeEvent({ message: "first" }));
    await firstTurnStarted;
    const second = batcher.submit("k", makeEvent({ message: "second" }));

    const [r1, r2] = await Promise.all([first, second]);
    expect(seen).toEqual(["first", "second"]);
    expect(r1.leader).toBe(true);
    expect(r2.leader).toBe(true);
    expect(r2.outcome!.reply).toBe("answer");
  });

  it("62. different conversations do not batch together", async () => {
    const seen: string[] = [];
    const batcher = new InboundBatcher({
      waitMs: 30,
      process: async (c) => {
        seen.push(c.message);
        return outcome("x");
      },
    });
    await Promise.all([
      batcher.submit("a", makeEvent({ message: "from a" })),
      batcher.submit("b", makeEvent({ message: "from b" })),
    ]);
    expect(seen.sort()).toEqual(["from a", "from b"]);
  });

  it("63. a failed turn rejects every waiter in it rather than half answering", async () => {
    const batcher = new InboundBatcher({
      waitMs: 20,
      process: async () => {
        throw new Error("pipeline blew up");
      },
    });
    const results = await Promise.allSettled([
      batcher.submit("k", makeEvent({ message: "a" })),
      batcher.submit("k", makeEvent({ message: "b" })),
    ]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
  });

  it("64. a failed turn does not wedge the key for the next one", async () => {
    let calls = 0;
    const batcher = new InboundBatcher({
      waitMs: 20,
      process: async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
        return outcome("recovered");
      },
    });
    await expect(batcher.submit("k", makeEvent({ message: "a" }))).rejects.toThrow("transient");
    const r = await batcher.submit("k", makeEvent({ message: "b" }));
    expect(r.outcome!.reply).toBe("recovered");
  });
});
