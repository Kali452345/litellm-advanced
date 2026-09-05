import { describe, expect, it } from "vitest";

import {
  holdText,
  MAX_HOLD_SECONDS,
  quotaSettingsState,
  type QuotaSettingsDraft,
  type QuotaSettingsLive,
} from "./quotaSettingsForm";

const live = (over: Partial<QuotaSettingsLive> = {}): QuotaSettingsLive => ({
  enforced: true,
  maxWaitSeconds: 75,
  ...over,
});

const draft = (over: Partial<QuotaSettingsDraft> = {}): QuotaSettingsDraft => ({
  enforced: true,
  holdSeconds: "75",
  ...over,
});

describe("holdText", () => {
  it("shows the budget the router is running with", () => {
    expect(holdText(12.5)).toBe("12.5");
  });

  it("shows nothing before the first poll answers", () => {
    expect(holdText(null)).toBe("");
  });
});

describe("quotaSettingsState", () => {
  it("has nothing to save before the first poll says what the router is running with", () => {
    expect(quotaSettingsState(draft({ holdSeconds: "30" }), live({ maxWaitSeconds: null }))).toEqual({
      kind: "loading",
    });
  });

  it("offers no save while the form still matches the router", () => {
    expect(quotaSettingsState(draft(), live())).toEqual({ kind: "unchanged" });
    expect(quotaSettingsState(draft({ enforced: false }), live({ enforced: false }))).toEqual({ kind: "unchanged" });
  });

  it("reads a budget the operator typed the same as the one the router reported", () => {
    expect(quotaSettingsState(draft({ holdSeconds: " 75.0 " }), live())).toEqual({ kind: "unchanged" });
  });

  it("sends the budget along with the flag when enforcement is turned on", () => {
    expect(quotaSettingsState(draft({ holdSeconds: "30" }), live({ enforced: false }))).toEqual({
      kind: "ready",
      update: { enable_quota_routing: true, quota_max_wait_seconds: 30 },
    });
  });

  it("saves a budget change on its own while enforcement stays on", () => {
    expect(quotaSettingsState(draft({ holdSeconds: "12.5" }), live())).toEqual({
      kind: "ready",
      update: { enable_quota_routing: true, quota_max_wait_seconds: 12.5 },
    });
  });

  it("keeps the running budget when enforcement is turned off", () => {
    expect(quotaSettingsState(draft({ enforced: false }), live({ maxWaitSeconds: 12.5 }))).toEqual({
      kind: "ready",
      update: { enable_quota_routing: false, quota_max_wait_seconds: 12.5 },
    });
  });

  it("lets enforcement be turned off while the budget field is half typed", () => {
    expect(quotaSettingsState(draft({ enforced: false, holdSeconds: "" }), live())).toEqual({
      kind: "ready",
      update: { enable_quota_routing: false, quota_max_wait_seconds: 75 },
    });
  });

  it("takes zero as a real budget, since zero is how holding is switched off", () => {
    expect(quotaSettingsState(draft({ holdSeconds: "0" }), live())).toEqual({
      kind: "ready",
      update: { enable_quota_routing: true, quota_max_wait_seconds: 0 },
    });
  });

  it("asks for a budget rather than saving an empty one", () => {
    expect(quotaSettingsState(draft({ holdSeconds: "   " }), live())).toEqual({
      kind: "invalid",
      message: "Enter how many seconds a request can be held. 0 never holds.",
    });
  });

  it.each(["12s", "abc", "-5", "1e3", ".5", "12.", "1,5"])("refuses %s, which is not a count of seconds", (typed) => {
    expect(quotaSettingsState(draft({ holdSeconds: typed }), live())).toEqual({
      kind: "invalid",
      message: "Seconds only, like 75 or 12.5.",
    });
  });

  it("refuses a budget that would outlast the caller waiting on it", () => {
    expect(quotaSettingsState(draft({ holdSeconds: String(MAX_HOLD_SECONDS + 1) }), live())).toMatchObject({
      kind: "invalid",
    });
    expect(quotaSettingsState(draft({ holdSeconds: String(MAX_HOLD_SECONDS) }), live())).toMatchObject({
      kind: "ready",
    });
  });
});
