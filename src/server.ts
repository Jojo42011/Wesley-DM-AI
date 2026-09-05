import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./persistence/index.js";
import { AnthropicLlm } from "./integrations/llm.js";
import { NullHandoff, WebhookHandoff, retryPendingHandoffs } from "./integrations/handoff.js";
import { ExampleStore } from "./voice/exampleStore.js";
import { handleTikTokWebhook } from "./app/tiktokWebhook.js";
import { handleRespondIoWebhook } from "./app/respondioWebhook.js";
import { RespondIoClient } from "./integrations/respondio.js";
import { getLeadConversation, getLeads, getMetrics, getTestLeadState } from "./api/dashboardApi.js";
import { createLogger } from "./observability/logger.js";
import { seedDemoData } from "./demo/seed.js";
import type { PipelineDeps } from "./app/dmPipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const PORT = Number(process.env.PORT ?? 3000);

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function serveStatic(res: http.ServerResponse, file: string, type: string): boolean {
  const full = path.join(PUBLIC_DIR, file);
  if (!existsSync(full)) return false;
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  res.end(readFileSync(full));
  return true;
}

async function main(): Promise<void> {
  const logger = createLogger();
  const store = await createStore();

  if (process.env.DEMO_MODE === "1") {
    await seedDemoData(store);
  }

  const exampleStore = new ExampleStore();
  exampleStore.loadFromFile(
    process.env.VOICE_EXAMPLES_PATH ?? path.resolve(__dirname, "..", "data", "voice-examples.json"),
  );

  const handoff = process.env.HANDOFF_WEBHOOK_URL
    ? new WebhookHandoff(process.env.HANDOFF_WEBHOOK_URL)
    : new NullHandoff();

  const deps: PipelineDeps = {
    store,
    llm: new AnthropicLlm(),
    handoff,
    exampleStore,
  };

  // respond.io is the production TikTok transport: it delivers inbound DMs
  // to /webhook/respondio and we send replies back through its API.
  const respondIoToken = process.env.RESPONDIO_API_TOKEN ?? "";
  const respondIo = new RespondIoClient(respondIoToken);
  let tiktokChannelId = process.env.RESPONDIO_TIKTOK_CHANNEL_ID
    ? Number(process.env.RESPONDIO_TIKTOK_CHANNEL_ID)
    : null;
  if (respondIoToken && tiktokChannelId === null) {
    tiktokChannelId = await respondIo.findTikTokChannelId().catch(() => null);
  }
  const respondIoDeps = {
    ...deps,
    respondIo,
    tiktokChannelId,
    webhookSecret: process.env.RESPONDIO_WEBHOOK_SECRET ?? null,
  };

  // Retry failed CRM handoffs in the background.
  const retryTimer = setInterval(() => {
    retryPendingHandoffs(store, handoff, logger).catch(() => {});
  }, 60_000);
  retryTimer.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "POST /webhook/tiktok") {
        const body = await readBody(req);
        if (body === null) return json(res, 400, { error: "invalid_json" });
        const result = await handleTikTokWebhook(deps, body);
        return json(res, result.status, result.body);
      }

      // Production transport: respond.io TikTok inbox.
      if (route === "POST /webhook/respondio") {
        const body = await readBody(req);
        if (body === null) return json(res, 400, { error: "invalid_json" });
        const secret =
          url.searchParams.get("secret") ??
          (req.headers["x-webhook-secret"] as string | undefined) ??
          null;
        const result = await handleRespondIoWebhook(respondIoDeps, body, { secret });
        return json(res, result.status, result.body);
      }

      if (route === "GET /health") {
        return json(res, 200, {
          ok: true,
          ts: new Date().toISOString(),
          transport: { respondio: Boolean(respondIoToken), tiktokChannelId },
        });
      }

      if (route === "GET /api/metrics") {
        return json(res, 200, await getMetrics(store));
      }

      if (route === "GET /api/leads") {
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return json(res, 200, await getLeads(store, Math.min(limit, 500)));
      }

      if (route === "GET /api/testing/state") {
        const user = url.searchParams.get("user") ?? "";
        const state = await getTestLeadState(store, user);
        return state ? json(res, 200, state) : json(res, 404, { error: "not_found" });
      }

      const convoMatch = url.pathname.match(/^\/api\/leads\/([\w-]+)\/conversation$/);
      if (req.method === "GET" && convoMatch) {
        const convo = await getLeadConversation(store, convoMatch[1]!);
        return convo ? json(res, 200, convo) : json(res, 404, { error: "not_found" });
      }

      // Dashboard frontend.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        if (serveStatic(res, "index.html", "text/html; charset=utf-8")) return;
      }
      if (req.method === "GET" && url.pathname === "/testing") {
        if (serveStatic(res, "testing.html", "text/html; charset=utf-8")) return;
      }

      json(res, 404, { error: "not_found" });
    } catch (err) {
      logger.log("pipeline_error", {
        route,
        error: err instanceof Error ? err.message : "unknown",
      });
      json(res, 500, { error: "internal_error" });
    }
  });

  server.listen(PORT, () => {
    logger.log("server_started", {
      port: PORT,
      store: process.env.STORE === "memory" ? "memory" : "sqlite",
      demoMode: process.env.DEMO_MODE === "1",
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
