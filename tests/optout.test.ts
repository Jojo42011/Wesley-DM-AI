import { describe, expect, it } from "vitest";
import { isOptOut } from "../src/modules/closeout.js";

describe("opt-out detection", () => {
  it("detects genuine opt-outs", () => {
    expect(isOptOut("stop")).toBe(true);
    expect(isOptOut("STOP.")).toBe(true);
    expect(isOptOut("please stop messaging me")).toBe(true);
    expect(isOptOut("stop texting me bro")).toBe(true);
    expect(isOptOut("unsubscribe")).toBe(true);
    expect(isOptOut("don't contact me again")).toBe(true);
    expect(isOptOut("leave me alone")).toBe(true);
    expect(isOptOut("remove me from your list")).toBe(true);
    expect(isOptOut("i want to opt out")).toBe(true);
  });

  it("never opts out real-estate talk containing 'stop'", () => {
    expect(isOptOut("me and my girl wanna stop renting")).toBe(false);
    expect(isOptOut("we want to stop throwing money away on rent")).toBe(false);
    expect(isOptOut("can I stop by the open house?")).toBe(false);
    expect(isOptOut("can't stop looking at zillow lol")).toBe(false);
    expect(isOptOut("should we stop waiting for rates to drop?")).toBe(false);
    expect(isOptOut("my landlord wants us out, need to stop leasing")).toBe(false);
  });
});

import { extractQualificationSignals } from "../src/modules/qualification.js";
import { makeLead } from "./helpers.js";

describe("qualification intent", () => {
  it("reads 'stop renting' as buy intent, not rent", () => {
    expect(extractQualificationSignals(makeLead(), "we wanna stop renting fr").buy_or_sell).toBe("buy");
    expect(extractQualificationSignals(makeLead(), "tired of paying rent every month").buy_or_sell).toBe("buy");
    expect(extractQualificationSignals(makeLead(), "looking to rent a place downtown").buy_or_sell).toBe("rent");
  });
});
