import { describe, expect, it } from "vitest";
import { enforceStyle, validateReply } from "../src/app/responseValidator.js";
import { WESLEY_REALTOR_LEADS } from "../src/config/campaigns.js";
import { makeLead } from "./helpers.js";

describe("Wesley style enforcement: no hyphens, no em dashes", () => {
  it("rewrites em and en dashes into natural pauses", () => {
    expect(enforceStyle("Credit in the 630s can work—lots of people do it")).toBe(
      "Credit in the 630s can work, lots of people do it",
    );
    expect(enforceStyle("No pressure — just here to help")).toBe(
      "No pressure, just here to help",
    );
    expect(enforceStyle("Rates matter less than price – trust me")).toBe(
      "Rates matter less than price, trust me",
    );
  });

  it("opens letter-to-letter hyphens and spaced hyphen separators", () => {
    expect(enforceStyle("pre-approval takes about a day")).toBe("pre approval takes about a day");
    expect(enforceStyle("quick call - whatever works")).toBe("quick call, whatever works");
  });

  it("never touches digits", () => {
    expect(enforceStyle("around 300-400k works")).toBe("around 300-400k works");
  });

  it("applies inside validateReply so no model reply ships with dashes", () => {
    const result = validateReply(
      "Good question — pre-approval is quick. Want me to walk you through it?",
      WESLEY_REALTOR_LEADS,
      makeLead(),
      [],
    );
    expect(result.reply).not.toMatch(/[—–]/);
    expect(result.reply).not.toMatch(/\p{L}-\p{L}/u);
  });
});
