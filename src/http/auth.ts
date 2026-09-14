/**
 * Dashboard and simulator authentication.
 *
 * WHY THIS EXISTS. The dashboard and its APIs served every lead, every phone
 * number and every full conversation to anyone who knew the URL, and the
 * ManyChat-shaped simulator at POST /webhook/tiktok let anyone create leads and
 * drive the pipeline. Neither is acceptable on a public host.
 *
 * WHAT IS NOT BEHIND THIS. /api/zernio/webhook and /health. The webhook proves
 * itself with an HMAC over its raw body, which is strictly stronger than a
 * shared bearer token and is the only credential Zernio can present; putting a
 * dashboard token in front of it would simply break the integration. /health
 * has to answer Fly's checker.
 *
 * FAIL CLOSED. With no DASHBOARD_TOKEN set, the dashboard refuses rather than
 * opening. The one exception is DEMO_MODE=1, which already means "this instance
 * is seeded with fake data for review".
 *
 * THE COOKIE. The dashboard is plain HTML with fetch() calls and no login
 * screen. Visiting /?token=... once sets an HttpOnly, SameSite=Strict cookie so
 * those fetches authenticate on their own, which is what makes a token-gated
 * dashboard usable at all without shipping the token into page JavaScript.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export const DASHBOARD_COOKIE = "wesley_dash";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function dashboardToken(): string {
  return process.env.DASHBOARD_TOKEN?.trim() ?? "";
}

function testingSecret(): string {
  return process.env.TESTING_WEBHOOK_SECRET?.trim() ?? "";
}

function demoMode(): boolean {
  return process.env.DEMO_MODE === "1";
}

export function dashboardAuthConfigured(): boolean {
  return Boolean(dashboardToken());
}

function bearer(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

function cookieValue(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

export type AuthOutcome = "ok" | "unauthorized" | "not_configured";

export function checkDashboardAuth(req: IncomingMessage, url: URL): AuthOutcome {
  /* A demo instance holds only seeded data and exists to be looked at. */
  if (demoMode() && !dashboardAuthConfigured()) return "ok";
  const expected = dashboardToken();
  if (!expected) return "not_configured";

  const candidates = [
    url.searchParams.get("token") ?? "",
    bearer(req),
    cookieValue(req, DASHBOARD_COOKIE),
  ];
  return candidates.some((c) => c && safeEqual(c, expected)) ? "ok" : "unauthorized";
}

/**
 * After a successful `?token=` visit, remember it for this browser so the
 * dashboard's own API calls work without the token in every URL.
 */
export function maybeSetDashboardCookie(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const fromQuery = url.searchParams.get("token");
  const expected = dashboardToken();
  if (!fromQuery || !expected || !safeEqual(fromQuery, expected)) return;
  res.setHeader("set-cookie", [
    `${DASHBOARD_COOKIE}=${encodeURIComponent(expected)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=604800`,
  ]);
}

/**
 * The ManyChat-shaped simulator at POST /webhook/tiktok.
 *
 * Kept, because the testing console is how Wesley's replies get reviewed
 * without burning a real lead, but no longer an open door on production. It
 * opens for exactly three things: a demo instance, a caller holding
 * TESTING_WEBHOOK_SECRET, or a session already authenticated to the dashboard
 * (which is what the /testing page itself uses).
 */
export function checkSimulatorAuth(req: IncomingMessage, url: URL): AuthOutcome {
  if (demoMode()) return "ok";

  const secret = testingSecret();
  if (secret) {
    const presented =
      (typeof req.headers["x-testing-secret"] === "string" ? req.headers["x-testing-secret"] : "") ||
      bearer(req) ||
      (url.searchParams.get("secret") ?? "");
    if (presented && safeEqual(presented, secret)) return "ok";
  }

  /* Whoever can read every conversation on the dashboard can also drive the
     simulator; withholding it from them protects nothing. */
  if (dashboardAuthConfigured() && checkDashboardAuth(req, url) === "ok") return "ok";

  return secret || dashboardAuthConfigured() ? "unauthorized" : "not_configured";
}
