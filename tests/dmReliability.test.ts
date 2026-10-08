import { afterEach, describe, expect, it, vi } from "vitest";
import { readConversationHistory, respondsToDmInvitation } from "../src/integrations/zernio/history.js";
import { deterministicGate } from "../src/modules/intentGate.js";
import { processInboundEvent } from "../src/app/dmPipeline.js";
import { makeDeps, makeEvent, makeLead, modelReply } from "./helpers.js";
import { requestsPhoneNumber } from "../src/app/propertyKnowledge.js";

afterEach(() => vi.restoreAllMocks());
const old = "2026-09-01T12:00:00Z", current = "2026-10-01T12:00:00Z";

describe("TikTok history recovery", () => {
  it("paginates REST message bodies, preserves direction, and excludes the current/future turns", async () => {
    const page = vi.fn().mockResolvedValueOnce({ ok: true, json: {
      messages: [{ id: "live", direction: "incoming", message: "price?", createdAt: current },
        { id: "future", direction: "incoming", message: "later", createdAt: "2026-10-02T12:00:00Z" }],
      pagination: { hasMore: true, nextCursor: "older" },
    }}).mockResolvedValueOnce({ ok: true, json: { messages: [
      { id: "phone", direction: "incoming", message: "210 555 0198", createdAt: old },
      { id: "opener", direction: "outgoing", text: "What number?", createdAt: "2026-08-31T12:00:00Z" },
      { id: "deleted", direction: "incoming", message: "ignore", createdAt: old, isDeleted: true },
    ], pagination: { hasMore: false } }});
    const result = await readConversationHistory({ conversationId: "c", accountId: "a", beforeMessageId: "live" }, page);
    expect(page.mock.calls[1]![0]).toContain("cursor=older");
    expect(result.complete).toBe(true);
    expect(result.messages.map(m => [m.id, m.role, m.text])).toEqual([
      ["opener", "assistant", "What number?"], ["phone", "user", "210 555 0198"],
    ]);
  });
  it("keeps partial context on provider failure and refuses an unknown boundary", async () => {
    const page = vi.fn().mockResolvedValueOnce({ ok: true, json: { messages: [
      { id: "old", direction: "incoming", message: "hello", createdAt: old },
    ], pagination: { hasMore: true, nextCursor: "next" } }}).mockRejectedValueOnce(new Error("offline"));
    const partial = await readConversationHistory({ conversationId: "c", accountId: "a", beforeAt: current }, page);
    expect(partial.complete).toBe(false);
    expect(partial.messages).toHaveLength(1);
    const noBoundary = await readConversationHistory({ conversationId: "c", accountId: "a" }, async () => ({ok:true,json:{messages:[{id:"old",direction:"incoming",message:"hello",createdAt:old}]}}));
    expect(noBoundary).toEqual({ messages: [], complete: false });
  });
  it("terminates a repeated pagination cursor", async () => {
    const page = vi.fn(async () => ({ok:true,json:{messages:[],pagination:{hasMore:true,nextCursor:"same"}}}));
    expect((await readConversationHistory({conversationId:"c",accountId:"a",beforeAt:current},page)).complete).toBe(false);
    expect(page).toHaveBeenCalledTimes(2);
  });
});

describe("reported DM failures", () => {
  it("blocks requests without question marks while preserving phone confirmations", () => {
    expect(requestsPhoneNumber("Please provide your phone number.")).toBe(true);
    expect(requestsPhoneNumber("What's the best number to reach you?")).toBe(true);
    expect(requestsPhoneNumber("I'll send the information to your number.")).toBe(false);
  });
  it("accepts the invitation reply without bypassing spam or denial guards", () => {
    expect(respondsToDmInvitation("heyyy u said to DM")).toBe(true);
    expect(deterministicGate("heyyy u said to DM")?.action).toBe("accept");
    expect(deterministicGate("you said to DM, f4f")?.action).toBe("reject");
    expect(deterministicGate("wrong person you said to DM")?.action).toBe("reject");
  });
  it("recovers a phone older than six messages, dedupes history, and never repeats a historical handoff", async () => {
    const deps = makeDeps();
    const history = Array.from({length:12},(_,i)=>({id:`h${i}`,role:"user" as const,text:i===0?"my number is 210 555 0198":`earlier message ${i}`,at:new Date(Date.parse(old)+i*1000).toISOString()}));
    const first = await processInboundEvent(deps,makeEvent({message:"heyyy u said to DM",conversationHistory:history}));
    const lead = await deps.store.leads.findByExternalId("tiktok","user_123");
    expect(lead?.phone).toBe("+12105550198");
    const second = await processInboundEvent(deps,makeEvent({message:"Price location?",conversationHistory:history}));
    expect(second.reply).toContain("verified");
    expect(second.reply).toContain("number on file");
    expect(second.reply).not.toMatch(/Austin|San Antonio|what.*number/i);
    const messages=await deps.store.conversations.getMessages(first.leadId!,100);
    expect(messages.filter(m=>m.providerMessageId?.startsWith("h"))).toHaveLength(12);
    expect(deps.handoff.calls).toHaveLength(0);
  });
  it("does not overwrite an existing number or revive an opted-out lead", async () => {
    const deps=makeDeps();
    const lead=makeLead({phone:"+15125550127",optedOut:true});await deps.store.leads.create(lead);
    const out=await processInboundEvent(deps,makeEvent({conversationHistory:[{id:"old",role:"user",text:"210 555 0198",at:old}]}));
    expect(out.reply).toBeNull();
    expect((await deps.store.leads.findByExternalId("tiktok","user_123"))?.phone).toBe("+15125550127");
    expect(deps.handoff.calls).toHaveLength(0);
  });
  it("blocks a listing question before a model can invent the city", async () => {
    const deps=makeDeps();await deps.store.leads.create(makeLead());
    deps.llm.handler=()=>modelReply("That property is in Austin with four bedrooms.");
    const out=await processInboundEvent(deps,makeEvent({message:"where is this property?"}));
    expect(out.decision).toBe("unverified_listing");
    expect(out.reply).not.toMatch(/Austin|four bedrooms/);
    expect(deps.llm.calls).toHaveLength(0);
  });
});
