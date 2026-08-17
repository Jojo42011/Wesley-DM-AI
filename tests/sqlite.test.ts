import { describe, expect, it } from "vitest";
import { SqliteStore } from "../src/persistence/sqlite.js";
import { processInboundEvent, type PipelineDeps } from "../src/app/dmPipeline.js";
import { FakeLlm } from "../src/integrations/llm.js";
import { ExampleStore } from "../src/voice/exampleStore.js";
import { ConversationStage } from "../src/domain/types.js";
import { makeEvent, interestedGate, modelReply, RecordingHandoff } from "./helpers.js";

const gateSystem = "classify whether an inbound TikTok DM";
const genSystem = "You write exactly one TikTok DM as Wesley";

function sqliteDeps(): PipelineDeps & { llm: FakeLlm } {
  return {
    store: new SqliteStore(":memory:"),
    llm: new FakeLlm(),
    handoff: new RecordingHandoff(),
    exampleStore: new ExampleStore(),
  };
}

describe("SQLite store (production persistence)", () => {
  it("runs the full pipeline: lead creation, capture, idempotency", async () => {
    const deps = sqliteDeps();
    deps.llm.handler = (req) => {
      if (req.system.includes(gateSystem)) return interestedGate;
      if (req.system.includes(genSystem))
        return modelReply("Happy to help — what's the best number to text you at?");
      return null;
    };

    // First message creates the lead.
    const first = await processInboundEvent(deps, makeEvent({ message: "im looking to buy", providerMessageId: "s1" }));
    expect(first.reply).toBeTruthy();
    expect(await deps.store.leads.count()).toBe(1);

    // Duplicate message ID is ignored (durable idempotency table).
    const dup = await processInboundEvent(deps, makeEvent({ message: "im looking to buy", providerMessageId: "s1" }));
    expect(dup.decision).toBe("duplicate_ignored");

    // Phone gets captured and persisted.
    const captured = await processInboundEvent(
      deps,
      makeEvent({ message: "sure its 512 761 8330", providerMessageId: "s2" }),
    );
    expect(captured.decision).toBe("contact_captured");
    const lead = await deps.store.leads.get(captured.leadId!);
    expect(lead!.phone).toBe("+15127618330");
    expect(lead!.stage).toBe(ConversationStage.HandoffReady);
    const captures = await deps.store.conversations.getContactCaptures(lead!.id);
    expect(captures).toHaveLength(1);

    // Alias lookup works (username stored via JSON aliases).
    const byAlias = await deps.store.leads.findByAlias("tiktok", "leadperson");
    expect(byAlias?.id).toBe(lead!.id);

    // countMessages excludes prefixed test leads.
    const all = await deps.store.conversations.countMessages();
    expect(all.user).toBeGreaterThan(0);
    const excluded = await deps.store.conversations.countMessages("user_");
    expect(excluded.user).toBe(0);

    await deps.store.close();
  });
});
