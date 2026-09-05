import { describe, expect, it } from "vitest";

import type { KeyQuotaUsage, ModelQuotaUsage, PoolQuotaUsage, QuotaWindowUsage } from "./useQuotaUsage";
import { formatCountdown, providerOf, toKeyView, toOverview, toPoolView, toPoolViews } from "./quotaSummary";

const window = (over: Partial<QuotaWindowUsage> = {}): QuotaWindowUsage => ({
  kind: "rpm",
  limit: 5,
  remaining: 5,
  used: 0,
  seconds_until_reset: 30,
  timezone: "UTC",
  ...over,
});

const key = (over: Partial<KeyQuotaUsage> = {}): KeyQuotaUsage => ({
  model_id: "dep-1",
  litellm_model: "openai/gpt-4o-mini",
  api_base: null,
  exhausted: false,
  seconds_until_room: null,
  windows: [window()],
  ...over,
});

const pool = (over: Partial<PoolQuotaUsage> = {}): PoolQuotaUsage => ({
  model_name: "gpt-4o-mini",
  exhausted: false,
  keys: [key()],
  ...over,
});

const usage = (over: Partial<ModelQuotaUsage> = {}): ModelQuotaUsage => ({
  enforced: true,
  max_wait_seconds: 75,
  pools: [pool()],
  ...over,
});

describe("formatCountdown", () => {
  it.each([
    { seconds: 0, expected: "now" },
    { seconds: -5, expected: "now" },
    { seconds: 1, expected: "1s" },
    { seconds: 42, expected: "42s" },
    { seconds: 59.2, expected: "60s" },
    { seconds: 60, expected: "1m" },
    { seconds: 125, expected: "2m 5s" },
    { seconds: 3600, expected: "1h" },
    { seconds: 8100, expected: "2h 15m" },
  ])("renders $seconds seconds as $expected", ({ seconds, expected }) => {
    expect(formatCountdown(seconds)).toBe(expected);
  });
});

describe("providerOf", () => {
  it("uses the resolved provider prefix when the model string carries one", () => {
    expect(providerOf(key({ litellm_model: "gemini/gemini-2.5-flash" }))).toBe("gemini");
  });

  it("falls back to the base url host when the model string has no prefix", () => {
    expect(providerOf(key({ litellm_model: "llama-3.3-70b", api_base: "https://api.groq.test/openai/v1" }))).toBe(
      "api.groq.test",
    );
  });

  it("keeps an unparseable base url verbatim rather than throwing", () => {
    expect(providerOf(key({ litellm_model: "local-model", api_base: "not a url" }))).toBe("not a url");
  });

  it("reports unknown when neither the model string nor a base url identifies the provider", () => {
    expect(providerOf(key({ litellm_model: "local-model", api_base: null }))).toBe("unknown");
  });
});

describe("toKeyView", () => {
  it("reports a key with no configured cap as unmetered and at zero headroom used", () => {
    const view = toKeyView(key({ windows: [] }));

    expect(view.metered).toBe(false);
    expect(view.windows).toHaveLength(0);
    expect(view.tightestFractionUsed).toBe(0);
  });

  it("takes the tightest window as the key's headroom, not the average", () => {
    const view = toKeyView(
      key({
        windows: [
          window({ kind: "rpm", limit: 5, used: 1, remaining: 4 }),
          window({ kind: "rpd", limit: 100, used: 90, remaining: 10 }),
        ],
      }),
    );

    expect(view.tightestFractionUsed).toBeCloseTo(0.9);
  });

  it("labels each window by the period it meters", () => {
    const view = toKeyView(key({ windows: [window({ kind: "rpm" }), window({ kind: "rpd" })] }));

    expect(view.windows.map((w) => w.label)).toEqual(["Per minute", "Per day"]);
  });

  it("marks a window spent the moment nothing is left, before the count reaches the limit", () => {
    const view = toKeyView(key({ windows: [window({ limit: 5, used: 4, remaining: 0 })] }));

    expect(view.windows[0].spent).toBe(true);
  });

  it("treats a zero limit as fully spent instead of dividing by zero", () => {
    const view = toKeyView(key({ windows: [window({ limit: 0, used: 0, remaining: 0 })] }));

    expect(view.windows[0].fractionUsed).toBe(1);
  });

  it("clamps a count that overshot its limit to a full bar", () => {
    const view = toKeyView(key({ windows: [window({ limit: 5, used: 7, remaining: 0 })] }));

    expect(view.windows[0].fractionUsed).toBe(1);
  });

  it("says nothing about readiness for a key that can take a request right now", () => {
    expect(toKeyView(key({ seconds_until_room: null })).readyIn).toBeNull();
  });

  it("counts down to when a spent key can be used again", () => {
    expect(toKeyView(key({ exhausted: true, seconds_until_room: 18 })).readyIn).toBe("18s");
  });
});

describe("toPoolView", () => {
  it("counts only the keys routing can still send to as available", () => {
    const view = toPoolView(
      pool({
        keys: [
          key({ model_id: "a", exhausted: true }),
          key({ model_id: "b", exhausted: false }),
          key({ model_id: "c", exhausted: false }),
        ],
      }),
    );

    expect(view.keyCount).toBe(3);
    expect(view.availableKeyCount).toBe(2);
  });

  it("withholds a countdown while some key in the pool can still answer", () => {
    const view = toPoolView(
      pool({ exhausted: false, keys: [key({ exhausted: true, seconds_until_room: 20 }), key({ model_id: "b" })] }),
    );

    expect(view.readyIn).toBeNull();
  });

  it("counts down to the soonest key when the whole pool is spent", () => {
    const view = toPoolView(
      pool({
        exhausted: true,
        keys: [
          key({ model_id: "a", exhausted: true, seconds_until_room: 50 }),
          key({ model_id: "b", exhausted: true, seconds_until_room: 12 }),
          key({ model_id: "c", exhausted: true, seconds_until_room: 31 }),
        ],
      }),
    );

    expect(view.readyIn).toBe("12s");
  });

  it("separates keys nothing meters from keys with a cap", () => {
    const view = toPoolView(pool({ keys: [key({ model_id: "a" }), key({ model_id: "b", windows: [] })] }));

    expect(view.meteredKeyCount).toBe(1);
  });
});

describe("toPoolViews", () => {
  it("orders pools by name so the list does not reshuffle between polls", () => {
    const ordered = usage({
      pools: [pool({ model_name: "sonnet" }), pool({ model_name: "flash" }), pool({ model_name: "haiku" })],
    });

    expect(toPoolViews(ordered).map((p) => p.modelName)).toEqual(["flash", "haiku", "sonnet"]);
  });

  it("renders nothing rather than throwing when usage has not loaded", () => {
    expect(toPoolViews(undefined)).toEqual([]);
  });
});

describe("toOverview", () => {
  it("totals keys and availability across every pool", () => {
    const totals = usage({
      pools: [
        pool({
          model_name: "flash",
          exhausted: true,
          keys: [key({ model_id: "a", exhausted: true }), key({ model_id: "b", exhausted: true })],
        }),
        pool({ model_name: "sonnet", keys: [key({ model_id: "c" }), key({ model_id: "d", windows: [] })] }),
      ],
    });

    expect(toOverview(totals, toPoolViews(totals))).toEqual({
      enforced: true,
      maxWaitSeconds: 75,
      poolCount: 2,
      keyCount: 4,
      availableKeyCount: 2,
      exhaustedPoolCount: 1,
      unmeteredKeyCount: 1,
    });
  });

  it("reports enforcement off when the router was built without quota routing", () => {
    const unenforced = usage({ enforced: false });

    expect(toOverview(unenforced, toPoolViews(unenforced)).enforced).toBe(false);
  });

  it("carries the hold budget the router is running with, so the control shows the live value", () => {
    expect(toOverview(usage({ max_wait_seconds: 12.5 }), []).maxWaitSeconds).toBe(12.5);
  });

  it("has no budget to show before the first poll answers", () => {
    expect(toOverview(undefined, []).maxWaitSeconds).toBeNull();
  });
});
