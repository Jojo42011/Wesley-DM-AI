/**
 * Dashboard and simulator access control.
 *
 * What is being protected: every lead, every phone number and every full
 * conversation, plus an endpoint that could create leads and drive the pipeline
 * from anywhere on the internet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  checkAdminAuth,
  checkDashboardAuth,
  checkSimulatorAuth,
  DASHBOARD_COOKIE,
} from "../src/http/auth.js";
import { getLeadConversation } from "../src/api/dashboardApi.js";
import { MemoryStore } from "../src/persistence/memory.js";
import { makeLead, makeMessage } from "./helpers.js";

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
  delete process.env.DASHBOARD_PUBLIC;
});
afterEach(() => {
  delete process.env.DASHBOARD_TOKEN;
  delete process.env.TESTING_WEBHOOK_SECRET;
  delete process.env.DEMO_MODE;
  delete process.env.DASHBOARD_PUBLIC;
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

describe("DASHBOARD_PUBLIC — the Lead Desk on the bare URL", () => {
  it("76. opens the dashboard and its read APIs with no token", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    process.env.DASHBOARD_PUBLIC = "1";
    expect(checkDashboardAuth(req(), at("/"))).toBe("ok");
    expect(checkDashboardAuth(req(), at("/api/leads"))).toBe("ok");
    expect(checkDashboardAuth(req(), at("/api/metrics"))).toBe("ok");
  });

  it("77. does NOT open the simulator, which creates leads and spends credits", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    process.env.DASHBOARD_PUBLIC = "1";
    expect(checkSimulatorAuth(req(), at("/webhook/tiktok"))).toBe("unauthorized");
    expect(
      checkSimulatorAuth(req({ authorization: `Bearer ${TOKEN}` }), at("/webhook/tiktok")),
    ).toBe("ok");
  });

  it("78. does NOT open the Zernio status endpoint", () => {
    process.env.DASHBOARD_TOKEN = TOKEN;
    process.env.DASHBOARD_PUBLIC = "1";
    expect(checkAdminAuth(req(), at("/api/zernio/status"))).toBe("unauthorized");
    expect(checkAdminAuth(req({ authorization: `Bearer ${TOKEN}` }), at("/api/zernio/status"))).toBe("ok");
  });

  it("79. redacts contact details out of transcripts while the dashboard is public", async () => {
    const store = new MemoryStore();
    const lead = makeLead({ phone: "+15127618330" });
    await store.leads.create(lead);
    await store.conversations.appendMessage(
      makeMessage({ leadId: lead.id, role: "user", text: "sure its 512 761 8330 or jane@example.com" }),
    );

    process.env.DASHBOARD_PUBLIC = "1";
    const open = (await getLeadConversation(store, lead.id)) as { messages: { text: string }[] };
    expect(open.messages[0]!.text).not.toContain("761");
    expect(open.messages[0]!.text).not.toContain("jane@example.com");
    expect(open.messages[0]!.text).toContain("[phone]");
    expect(open.messages[0]!.text).toContain("[email]");

    delete process.env.DASHBOARD_PUBLIC;
    const locked = (await getLeadConversation(store, lead.id)) as { messages: { text: string }[] };
    /* Behind the token the thread reads exactly as the lead typed it. */
    expect(locked.messages[0]!.text).toContain("512 761 8330");
  });

  it("80. leaves the lead card masked either way", async () => {
    const store = new MemoryStore();
    const lead = makeLead({ phone: "+15127618330" });
    await store.leads.create(lead);
    for (const mode of ["1", undefined]) {
      if (mode) process.env.DASHBOARD_PUBLIC = mode;
      else delete process.env.DASHBOARD_PUBLIC;
      const r = (await getLeadConversation(store, lead.id)) as { lead: { phone: string } };
      expect(r.lead.phone).toBe("•••• 8330");
    }
  });
});
