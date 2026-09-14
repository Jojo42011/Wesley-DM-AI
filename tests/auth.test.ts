/**
 * Dashboard and simulator access control.
 *
 * What is being protected: every lead, every phone number and every full
 * conversation, plus an endpoint that could create leads and drive the pipeline
 * from anywhere on the internet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { checkDashboardAuth, checkSimulatorAuth, DASHBOARD_COOKIE } from "../src/http/auth.js";

const TOKEN = "dash-token-abc123";

function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}
function at(path: string): URL {
  return new URL(path, "https://wesley-dm-ai.fly.dev");
}

beforeEach(() => {
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.TESTING_WEBHOOK_SECRET;
  delete process.env.DEMO_MODE;
});
afterEach(() => {
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.TESTING_WEBHOOK_SECRET;
  delete process.env.DEMO_MODE;
});

describe("dashboard access", () => {
  it("65. an anonymous request is refused", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    expect(checkDashboardAuth(req(), at("/api/leads"))).toBe("unauthorized");
  });

  it("66. a wrong token is refused", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    expect(checkDashboardAuth(req(), at("/api/leads?token=nope"))).toBe("unauthorized");
    expect(checkDashboardAuth(req({ authorization: "Bearer nope" }), at("/api/leads"))).toBe("unauthorized");
  });

  it("67. the right token is accepted by query, bearer or cookie", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    expect(checkDashboardAuth(req(), at(`/?token=${TOKEN}`))).toBe("ok");
    expect(checkDashboardAuth(req({ authorization: `Bearer ${TOKEN}` }), at("/api/metrics"))).toBe("ok");
    expect(
      checkDashboardAuth(req({ cookie: `${DASHBOARD_COOKIE}=${TOKEN}; other=1` }), at("/api/metrics")),
    ).toBe("ok");
  });

  it("68. with no token configured the dashboard is CLOSED, not open", () => {
    expect(checkDashboardAuth(req(), at("/api/leads"))).toBe("not_configured");
  });

  it("69. a demo instance stays viewable without a token", () => {
    process.env.DEMO_MODE = "1";
    expect(checkDashboardAuth(req(), at("/"))).toBe("ok");
  });

  it("70. a token set on a demo instance is still enforced", () => {
    process.env.DEMO_MODE = "1";
    process.env.DASHBOARD_TOKEN = TOKEN;
    expect(checkDashboardAuth(req(), at("/"))).toBe("unauthorized");
    expect(checkDashboardAuth(req(), at(`/?token=${TOKEN}`))).toBe("ok");
  });
});

describe("the testing simulator", () => {
  it("71. is not an open production backdoor", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    expect(checkSimulatorAuth(req(), at("/webhook/tiktok"))).toBe("unauthorized");
  });

  it("72. opens for the testing secret", () => {
    process.env.TESTING_WEBHOOK_SECRET = "testing-secret-xyz";
    expect(checkSimulatorAuth(req({ "x-testing-secret": "testing-secret-xyz" }), at("/webhook/tiktok"))).toBe("ok");
    expect(checkSimulatorAuth(req({ "x-testing-secret": "wrong" }), at("/webhook/tiktok"))).toBe("unauthorized");
  });

  it("73. opens for a session already authenticated to the dashboard", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    expect(
      checkSimulatorAuth(req({ cookie: `${DASHBOARD_COOKIE}=${TOKEN}` }), at("/webhook/tiktok")),
    ).toBe("ok");
  });

  it("74. opens on a demo instance", () => {
    process.env.DEMO_MODE = "1";
    expect(checkSimulatorAuth(req(), at("/webhook/tiktok"))).toBe("ok");
  });

  it("75. reports not_configured when neither secret exists, so it cannot be left open by accident", () => {
    expect(checkSimulatorAuth(req(), at("/webhook/tiktok"))).toBe("not_configured");
  });
});
