import { describe, expect, it } from "vitest";

import type { KeyView, WindowView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";

import {
  observedByKey,
  observedHint,
  toObservedKeyView,
  toObservedOverview,
  type ObservedKeyView,
} from "./observedLimits";
import type { ObservedKeyLimits, ObservedRateLimits, ObservedWindow } from "./useObservedRateLimits";

const NOW = new Date("2026-09-05T12:00:00Z");

const liveWindow = (kind: WindowView["kind"], limit: number): WindowView => ({
  kind,
  label: kind === "rpm" ? "Per minute" : "Per day",
  used: 0,
  limit,
  remaining: limit,
  fractionUsed: 0,
  spent: false,
  resetsIn: "30s",
  timezone: "UTC",
});

const keyView = (modelId: string, windows: WindowView[]): KeyView => ({
  modelId,
  litellmModel: "gemini/gemini-2.5-flash",
  provider: "gemini",
  apiBase: null,
  exhausted: false,
  metered: windows.length > 0,
  windows,
  readyIn: null,
  tightestFractionUsed: 0,
});

const observedWindow = (kind: ObservedWindow["kind"], allowed: number, configuredThen: number): ObservedWindow => ({
  kind,
  configured_limit: configuredThen,
  refusals: 3,
  lowest_count_at_refusal: allowed + 1,
  highest_count_at_refusal: allowed + 4,
  suggested_limit: allowed,
});

const observedKey = (
  modelId: string,
  windows: ObservedWindow[],
  extra: Partial<ObservedKeyLimits> = {},
): ObservedKeyLimits => ({
  model_id: modelId,
  model_group: "flash-pool",
  litellm_model_name: "gemini-2.5-flash",
  api_base: "https://generativelanguage.googleapis.com",
  refusals: 3,
  last_refusal: "2026-09-05T11:58:00Z",
  windows,
  ...extra,
});

const derive = (limits: ObservedKeyLimits, live: KeyView): ObservedKeyView => toObservedKeyView(limits, live, NOW);

const onlyWindow = (limits: ObservedKeyLimits, live: KeyView) => derive(limits, live).windows[0];

describe("observed rate limits", () => {
  it("says how far above the provider's real ceiling a configured cap sits", () => {
    const window = onlyWindow(
      observedKey("d1", [observedWindow("rpm", 5, 10)]),
      keyView("d1", [liveWindow("rpm", 10)]),
    );

    expect(window.verdict).toBe("too_high");
    expect(window.allowed).toBe(5);
    expect(window.headline).toBe("Allowed 5, so Requests Per Minute is 5 too high");
  });

  it("judges the cap the router is enforcing now, not the one set when the refusal landed", () => {
    const raised = onlyWindow(observedKey("d1", [observedWindow("rpm", 5, 10)]), keyView("d1", [liveWindow("rpm", 5)]));

    expect(raised.verdict).toBe("matches");
    expect(raised.headline).toBe("Allowed 5, which is what Requests Per Minute is set to");
  });

  it("falls back to the cap that was set at the refusal when the key has no such window now", () => {
    const window = onlyWindow(observedKey("d1", [observedWindow("rpd", 50, 100)]), keyView("d1", []));

    expect(window.configured).toBe(100);
    expect(window.headline).toBe("Allowed 50, so Requests Per Day is 50 too high");
  });

  it("reports the room left when a cap is tighter than what the provider allows", () => {
    const window = onlyWindow(observedKey("d1", [observedWindow("rpm", 8, 8)]), keyView("d1", [liveWindow("rpm", 5)]));

    expect(window.verdict).toBe("room_to_spare");
    expect(window.headline).toBe("Allowed 8, so Requests Per Minute has 3 to spare");
  });

  it("does not read a refusal with nothing spent as a cap of zero", () => {
    const window = onlyWindow(observedKey("d1", [observedWindow("rpm", 0, 5)]), keyView("d1", [liveWindow("rpm", 5)]));

    expect(window.verdict).toBe("nothing_fits");
    expect(window.headline).toBe("Refused with nothing spent, so its window had not rolled over yet");
  });

  it("bounds the minute window and the day window separately", () => {
    const view = derive(
      observedKey("d1", [observedWindow("rpm", 5, 5), observedWindow("rpd", 50, 100)]),
      keyView("d1", [liveWindow("rpm", 5), liveWindow("rpd", 100)]),
    );

    expect(view.windows.map((window) => [window.label, window.verdict])).toEqual([
      ["Per minute", "matches"],
      ["Per day", "too_high"],
    ]);
  });

  it("says how long ago the provider last refused the key", () => {
    const view = derive(observedKey("d1", [observedWindow("rpm", 5, 5)]), keyView("d1", []));

    expect(view.lastRefusal).toBe("2m ago");
  });

  it("does not report a refusal seconds old as a stale one", () => {
    const view = derive(
      observedKey("d1", [observedWindow("rpm", 5, 5)], { last_refusal: "2026-09-05T11:59:30Z" }),
      keyView("d1", []),
    );

    expect(view.lastRefusal).toBe("just now");
  });

  it("carries the longest wait a provider asked for, and nothing when none did", () => {
    const asked = derive(
      observedKey("d1", [observedWindow("rpm", 5, 5)], { longest_retry_after_seconds: 3600 }),
      keyView("d1", []),
    );

    expect(asked.longestWait).toBe("1h");
    expect(derive(observedKey("d1", [observedWindow("rpm", 5, 5)]), keyView("d1", [])).longestWait).toBeNull();
  });

  it("indexes what was observed by the key it was observed on", () => {
    const observed: ObservedRateLimits = {
      since: "2026-09-04T12:00:00Z",
      refusals_read: 4,
      unmetered_refusals: 1,
      keys: [observedKey("d1", []), observedKey("d2", [])],
    };

    expect([...observedByKey(observed).keys()]).toEqual(["d1", "d2"]);
    expect(observedByKey(undefined).size).toBe(0);
  });

  it("counts every cap sitting above the provider's ceiling across the pools", () => {
    const observed: ObservedRateLimits = {
      since: "2026-09-04T12:00:00Z",
      refusals_read: 9,
      unmetered_refusals: 2,
      keys: [
        observedKey("d1", [observedWindow("rpm", 5, 10), observedWindow("rpd", 50, 100)]),
        observedKey("d2", [observedWindow("rpm", 8, 8)]),
        observedKey("gone", [observedWindow("rpm", 1, 10)]),
      ],
    };

    const overview = toObservedOverview(observed, [
      keyView("d1", [liveWindow("rpm", 10), liveWindow("rpd", 100)]),
      keyView("d2", [liveWindow("rpm", 8)]),
    ]);

    expect(overview.capsTooHigh).toBe(2);
    expect([overview.refusalsRead, overview.unmeteredRefusals]).toEqual([9, 2]);
  });

  it("counts nothing when no refusal has been logged yet", () => {
    const overview = toObservedOverview(undefined, [keyView("d1", [liveWindow("rpm", 10)])]);

    expect([overview.capsTooHigh, overview.refusalsRead, overview.unmeteredRefusals]).toEqual([0, 0, 0]);
  });

  it("says nothing has been measured rather than that every cap is right", () => {
    expect(observedHint({ refusalsRead: 0, unmeteredRefusals: 0, capsTooHigh: 0 }, 24)).toBe(
      "No rate limit refusal logged in the last 24h",
    );
    expect(observedHint({ refusalsRead: 7, unmeteredRefusals: 7, capsTooHigh: 0 }, 24)).toBe(
      "7 refusals logged, none with a count behind them",
    );
  });

  it("says how many of the refusals read carried a count worth bounding a cap with", () => {
    expect(observedHint({ refusalsRead: 9, unmeteredRefusals: 2, capsTooHigh: 1 }, 24)).toBe(
      "Measured from 7 of 9 refusals",
    );
    expect(observedHint({ refusalsRead: 1, unmeteredRefusals: 0, capsTooHigh: 1 }, 6)).toBe(
      "Measured from 1 of 1 refusal",
    );
  });
});
