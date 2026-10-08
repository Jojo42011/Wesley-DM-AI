import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleInboundComment, enqueueComment, drainCommentQueue } from "../src/agents/commentAgent/index.js";
import { getCommentAgentDb, getRecentCommentActions, resetCommentAgentDbForTests } from "../src/persistence/commentAgentStore.js";
import { readBackComment, type ZernioInboundComment } from "../src/integrations/zernio/comments.js";

let dir:string, posted:string[];
const event=(id:string):ZernioInboundComment=>({eventId:id,commentId:id,platformPostId:"video",postId:null,platform:"tiktok",text:"info",authorId:id,authorUsername:id,createdAt:new Date().toISOString(),isReply:false,parentCommentId:null,accountId:"acct"});
beforeEach(()=>{
 resetCommentAgentDbForTests();dir=mkdtempSync(path.join(tmpdir(),"comment-reliability-"));posted=[];
 vi.stubEnv("COMMENT_AGENT_DB_PATH",path.join(dir,"ledger.db"));vi.stubEnv("COMMENT_AGENT_ENABLED","true");
 vi.stubEnv("COMMENT_AGENT_MIN_SPACING_SEC","0");vi.stubEnv("COMMENT_AGENT_MAX_PER_HOUR","100");vi.stubEnv("COMMENT_AGENT_MAX_PER_DAY","100");vi.stubEnv("ZERNIO_DM_API_KEY","fake-test-key");
 vi.stubGlobal("fetch",vi.fn(async (_url:string,init?:RequestInit)=>{
  if(init?.method==="POST"){posted.push(JSON.parse(String(init.body)).message);return new Response(JSON.stringify({commentId:`posted${posted.length}`}));}
  return new Response(JSON.stringify({comments:["a","b","c"].map(id=>({id,from:{isOwner:false},canReply:true,message:"info"}))}));
 }));
});
afterEach(()=>{resetCommentAgentDbForTests();vi.unstubAllEnvs();vi.unstubAllGlobals();rmSync(dir,{recursive:true,force:true});});

describe("comment reliability",()=>{
 it("never publishes invented city, price or specs from the model",async()=>{
  const result=await handleInboundComment(event("a"),"acct",{classify:async()=>({bucket:"high_intent",reply:"Austin, $450,000, 4 bedrooms",reason:"asked"})});
  expect(result.decision).toBe("replied");expect(posted).toHaveLength(1);
  expect(posted[0]).not.toMatch(/Austin|450|bedrooms|can't|cannot/);
 });
 it("recognizes an existing contact and answers explicit info without the model",async()=>{
  await handleInboundComment(event("a"),"acct",{knownContact:true});
  expect(posted[0]).toContain("continue in our messages");
 });
 it("persists rate-limited work across a database reopen then sends it once",async()=>{
  vi.stubEnv("COMMENT_AGENT_MAX_PER_HOUR","1");
  enqueueComment(event("a"),"acct");enqueueComment(event("b"),"acct");
  await drainCommentQueue();expect(posted).toHaveLength(1);
  expect(getRecentCommentActions().find(r=>r.commentId==="b")?.decision).toBe("skipped_rate_limit");
  resetCommentAgentDbForTests();
  getCommentAgentDb().prepare("UPDATE comment_actions SET acted_at=? WHERE decision='replied'").run(new Date(Date.now()-7200000).toISOString());
  getCommentAgentDb().prepare("UPDATE comment_queue SET next_attempt=0 WHERE status='pending'").run();
  await drainCommentQueue();expect(posted).toHaveLength(2);
  enqueueComment(event("b"),"acct");await drainCommentQueue();expect(posted).toHaveLength(2);
 });
 it("reads beyond the first comment page",async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({comments:[],pagination:{hasMore:true,nextCursor:"page2"}})))
   .mockResolvedValueOnce(new Response(JSON.stringify({comments:[{id:"target",from:{isOwner:false},canReply:true,message:"price?"}],pagination:{hasMore:false}})));
  vi.stubGlobal("fetch",fetch);
  expect((await readBackComment("video","target","acct")).found).toBe(true);
  expect(String(fetch.mock.calls[1]![0])).toContain("cursor=page2");
 });
 it("leaves ambiguous POST failures terminal instead of risking duplicate public replies",async()=>{
  const read=globalThis.fetch;
  vi.stubGlobal("fetch",vi.fn(async (url:string,init?:RequestInit)=>{
    if(init?.method==="POST")throw new Error("connection lost after send");
    return read(url,init);
  }));
  enqueueComment(event("a"),"acct");await drainCommentQueue();
  expect(getRecentCommentActions()[0]?.decision).toBe("failed");
  expect(getCommentAgentDb().prepare("SELECT status FROM comment_queue").get()).toEqual({status:"done"});
 });
});
