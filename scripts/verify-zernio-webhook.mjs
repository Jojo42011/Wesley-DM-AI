/**
 * verify-zernio-webhook.mjs — the Zernio TikTok DM transport, against a real
 * server over real HTTP.
 *
 * WHY THIS EXISTS ALONGSIDE `npm test`. The vitest suite drives the handler
 * directly, which proves the logic. It cannot prove the two things that are
 * properties of the SERVER: that the route reads the exact raw bytes before
 * anything parses them, and that the ack lands inside Zernio's five second
 * budget while the pipeline is still running. Only a live request shows those.
 *
 * Run:  npm run build && node scripts/verify-zernio-webhook.mjs
 * It starts its own server on PORT_TEST (default 3999) with throwaway secrets
 * and an in-memory store, so it touches nothing real.
 */
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SECRET = "verify-secret-do-not-use-in-production";
const DASH = "verify-dashboard-token";
const ACCOUNT = "acct_wesley_verify";
const OTHER_ACCOUNT = "acct_someone_else";
const PORT = process.env.PORT_TEST || "3999";
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sign = (body, secret = SECRET) =>
  createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");

function inboundBody(over = {}) {
  return JSON.stringify({
    id: over.eventId ?? "evt_verify_1",
    event: over.event ?? "message.received",
    message: {
      id: over.platformMessageId ?? "msg_1",
      conversationId: over.conversationId ?? "conv_verify",
      platform: over.platform ?? "tiktok",
      platformMessageId: over.platformMessageId ?? "ptf_1",
      direction: over.direction ?? "incoming",
      text: "text" in over ? over.text : "hey saw your video, looking to buy my first place",
      attachments: [],
      sender: "sender" in over ? over.sender : { id: "tt_verify_user", name: "Jane B", username: "janeb" },
      sentAt: new Date().toISOString(),
    },
    conversation: {
      id: over.conversationId ?? "conv_verify",
      participantId: "participantId" in over ? over.participantId : "tt_verify_user",
      participantName: "Jane B",
      participantUsername: "janeb",
    },
    account: {
      id: over.accountId ?? ACCOUNT,
      accountId: over.accountId ?? ACCOUNT,
      platform: over.platform ?? "tiktok",
      username: "wesley.realtor",
    },
    timestamp: new Date().toISOString(),
  });
}

function post(body, signature) {
  const headers = { "Content-Type": "application/json" };
  if (signature !== null) headers["X-Zernio-Signature"] = signature;
  return fetch(`${BASE}/api/zernio/webhook`, { method: "POST", headers, body });
}

async function startServer(extraEnv = {}) {
  const server = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      PORT,
      STORE: "memory",
      NODE_ENV: "test",
      DASHBOARD_TOKEN: DASH,
      ZERNIO_WEBHOOK_SECRET: SECRET,
      ZERNIO_DM_API_KEY: "zrk_verify_not_a_real_key",
      ZERNIO_TIKTOK_ACCOUNT_ID: ACCOUNT,
      /* Point the client at a host that cannot resolve, so a send attempt fails
         fast and locally instead of reaching the real Zernio. */
      ZERNIO_API_BASE: "http://127.0.0.1:9/api/v1",
      ZERNIO_DEBOUNCE_MS: "400",
      ANTHROPIC_API_KEY: "",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));

  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return { server, getLog: () => log };
    } catch {
      /* still booting */
    }
  }
  return { server, getLog: () => log, failed: true };
}

async function failClosedChecks() {
  console.log("\nFAIL CLOSED — a server with no webhook secret");
  const { server, getLog, failed } = await startServer({ ZERNIO_WEBHOOK_SECRET: "" });
  try {
    check("server booted", !failed, failed ? getLog().slice(-600) : "");
    if (failed) return;
    const body = inboundBody();
    const r = await post(body, sign(body));
    check("unset ZERNIO_WEBHOOK_SECRET closes the webhook with 503", r.status === 503, `got ${r.status}`);
  } finally {
    server.kill("SIGKILL");
    await sleep(300);
  }
}

async function liveChecks() {
  console.log("\nLIVE — the real route on a real server");
  const { server, getLog, failed } = await startServer();
  try {
    check("server booted", !failed, failed ? getLog().slice(-800) : "");
    if (failed) return;

    check("health is open for Fly's checker", (await fetch(`${BASE}/health`)).ok);

    // ── signature ────────────────────────────────────────────────────────
    check("bad signature -> 401", (await post(inboundBody({ eventId: "e_bad" }), "deadbeef")).status === 401);
    check("missing signature -> 401", (await post(inboundBody({ eventId: "e_nosig" }), null)).status === 401);

    const b = inboundBody({ eventId: "e_tamper" });
    check(
      "body modified after signing -> 401",
      (await post(b.replace("first place", "bank details"), sign(b))).status === 401,
    );

    const bad = "{not json";
    check("signed but unparseable body -> 400", (await post(bad, sign(bad))).status === 400, "");

    // ── events that must be ignored, never retried ───────────────────────
    for (const [label, over, reason] of [
      ["our own outgoing echo", { eventId: "e_echo", direction: "outgoing" }, "outgoing_echo"],
      ["a non-message event", { eventId: "e_evt", event: "comment.received" }, "unsupported_event"],
      ["a non-TikTok message", { eventId: "e_ig", platform: "instagram" }, "unsupported_platform"],
      ["a payload with no sender", { eventId: "e_nosender", sender: {}, participantId: undefined }, "missing_identity"],
    ]) {
      const body = inboundBody(over);
      const r = await post(body, sign(body));
      const j = await r.json();
      check(`${label} -> 200 ignored (${reason})`, r.status === 200 && j.ignored === true, `got ${r.status}`);
    }

    // ── account isolation ────────────────────────────────────────────────
    {
      const body = inboundBody({ eventId: "e_other", accountId: OTHER_ACCOUNT });
      const r = await post(body, sign(body));
      const j = await r.json();
      check(
        "another Zernio account -> 200 ignored, never processed",
        r.status === 200 && j.ignored === true && j.reason === "account_mismatch",
      );
    }

    // ── the headline property: ack speed ─────────────────────────────────
    const good = inboundBody({ eventId: "e_ok" });
    const t0 = Date.now();
    const r4 = await post(good, sign(good));
    const ms = Date.now() - t0;
    check("valid inbound -> 200", r4.status === 200, `got ${r4.status}`);
    check(`acked in ${ms}ms, inside Zernio's 5000ms budget`, ms < 5000, `${ms}ms would earn a retry`);
    check(
      `acked in ${ms}ms, ahead of the 400ms batching window used here`,
      ms < 400,
      "the ack is waiting on the pipeline, which is the bug this design exists to avoid",
    );

    // ── duplicate delivery ───────────────────────────────────────────────
    {
      const r = await post(good, sign(good));
      const j = await r.json();
      check("replayed event id -> 200 duplicate, not reprocessed", r.status === 200 && j.duplicate === true);
    }

    // ── the async half really ran after the ack ──────────────────────────
    await sleep(2500);
    const log = getLog();
    check(
      "pipeline ran AFTER the ack",
      /"event":"(inbound_accepted|intent_gate|pipeline_complete|zernio_reply_send|pipeline_error)"/.test(log),
      "no pipeline activity in the server log",
    );
    check("no API key or webhook secret appears in the logs", !log.includes(SECRET) && !log.includes("zrk_verify"));

    // ── the dashboard is no longer public ────────────────────────────────
    for (const p of ["/", "/testing", "/api/metrics", "/api/leads", "/api/testing/state?user=x", "/api/zernio/status"]) {
      check(`${p} refuses an anonymous request`, (await fetch(`${BASE}${p}`)).status === 401);
    }
    check(
      "/api/leads opens with the dashboard token",
      (await fetch(`${BASE}/api/leads`, { headers: { authorization: `Bearer ${DASH}` } })).ok,
    );

    // ── the simulator is no longer an open backdoor ──────────────────────
    {
      const r = await fetch(`${BASE}/webhook/tiktok`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "attacker", message: "let me in" }),
      });
      check("POST /webhook/tiktok refuses an anonymous request", r.status === 401, `got ${r.status}`);
    }

    // ── the status endpoint never returns the credentials ────────────────
    {
      const r = await fetch(`${BASE}/api/zernio/status`, { headers: { authorization: `Bearer ${DASH}` } });
      const text = await r.text();
      check("/api/zernio/status answers for an authorised caller", r.ok, `got ${r.status}`);
      check("status reports the key and secret as configured", /"apiKeyConfigured":true/.test(text) && /"webhookSecretConfigured":true/.test(text));
      check("status never returns the key or the secret", !text.includes("zrk_verify") && !text.includes(SECRET));
    }
  } finally {
    server.kill("SIGKILL");
  }
}

await failClosedChecks();
await liveChecks();

console.log(`\n${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
