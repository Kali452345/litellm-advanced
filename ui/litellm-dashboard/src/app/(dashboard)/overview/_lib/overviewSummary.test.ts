import { describe, expect, it } from "vitest";

import type { AnalyticsTotals, BreakdownRow } from "../../_lib/analyticsSummary";
import type { KeyView, PoolView, QuotaOverview } from "../../hooks/quotaUsage/quotaSummary";
import { attentionItems, rangeById, rangeFor, rotationRows, topModels } from "./overviewSummary";

const key = (over: Partial<KeyView> = {}): KeyView => ({
  modelId: "id",
  litellmModel: "openai/gpt-4o-mini",
  provider: "openai",
  apiBase: null,
  exhausted: false,
  metered: true,
  windows: [],
  readyIn: null,
  tightestFractionUsed: 0,
  ...over,
});

const pool = (over: Partial<PoolView> = {}): PoolView => {
  const keys = over.keys ?? [key()];
  return {
    modelName: "flash",
    exhausted: keys.every((candidate) => candidate.exhausted),
    keyCount: keys.length,
    availableKeyCount: keys.filter((candidate) => !candidate.exhausted).length,
    meteredKeyCount: keys.filter((candidate) => candidate.metered).length,
    readySeconds: null,
    readyIn: null,
    ...over,
    keys,
  };
};

const overview = (over: Partial<QuotaOverview> = {}): QuotaOverview => ({
  enforced: true,
  maxWaitSeconds: 75,
  poolCount: 1,
  keyCount: 1,
  availableKeyCount: 1,
  exhaustedPoolCount: 0,
  unmeteredKeyCount: 0,
  ...over,
});

const totals = (over: Partial<AnalyticsTotals> = {}): AnalyticsTotals => ({
  requests: 0,
  successful: 0,
  failed: 0,
  failureRate: 0,
  spend: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  cacheHitRate: 0,
  tokensPerRequest: 0,
  promptTokensPerRequest: 0,
  completionTokensPerRequest: 0,
  spendPerRequest: 0,
  ...over,
});

const modelRow = (over: Partial<BreakdownRow>): BreakdownRow => ({
  name: "flash",
  requests: 0,
  successful: 0,
  failed: 0,
  failureRate: 0,
  totalTokens: 0,
  promptTokens: 0,
  completionTokens: 0,
  tokensPerRequest: 0,
  spend: 0,
  ...over,
});

const healthy = { totals: totals(), models: [], pools: [pool({ keys: [key(), key()] })], quota: overview() };

describe("rangeFor", () => {
  const now = new Date("2026-09-02T12:00:00Z");

  it("counts today as the first day of the window", () => {
    expect(rangeFor(1, now).from.toISOString()).toBe("2026-09-02T12:00:00.000Z");
    expect(rangeFor(7, now).from.toISOString()).toBe("2026-08-27T12:00:00.000Z");
    expect(rangeFor(30, now).from.toISOString()).toBe("2026-08-04T12:00:00.000Z");
  });

  it("ends the window now, so today's partial day is included", () => {
    expect(rangeFor(7, now).to.toISOString()).toBe("2026-09-02T12:00:00.000Z");
  });
});

describe("rangeById", () => {
  it("resolves the tab the user picked", () => {
    expect(rangeById("today").days).toBe(1);
    expect(rangeById("30d").days).toBe(30);
  });

  it("falls back to a week when the id is not one of the tabs", () => {
    expect(rangeById("all-time")).toEqual({ id: "7d", label: "7 days", days: 7 });
  });
});

describe("topModels", () => {
  const rows = [
    modelRow({
      name: "flash",
      requests: 50,
      successful: 40,
      failed: 10,
      failureRate: 0.2,
      totalTokens: 4000,
      tokensPerRequest: 100,
      spend: 0.5,
    }),
    modelRow({ name: "sonnet", requests: 30 }),
    modelRow({ name: "haiku", requests: 20 }),
  ];

  it("shares against every model, not just the ones it shows", () => {
    const top = topModels(rows, 2);

    expect(top.map((model) => model.name)).toEqual(["flash", "sonnet"]);
    expect(top.map((model) => model.share)).toEqual([0.5, 0.3]);
  });

  it("carries everything the panel puts on the row", () => {
    expect(topModels(rows, 1)[0]).toEqual({
      name: "flash",
      requests: 50,
      share: 0.5,
      failureRate: 0.2,
      totalTokens: 4000,
      tokensPerRequest: 100,
      spend: 0.5,
    });
  });

  it("reports no share rather than NaN before anything has served", () => {
    expect(topModels([modelRow({ name: "flash" })], 5)[0].share).toBe(0);
    expect(topModels([], 5)).toEqual([]);
  });
});

describe("rotationRows", () => {
  const rows = rotationRows([
    pool({
      modelName: "serving-busy",
      keys: [key({ tightestFractionUsed: 0.8 }), key({ tightestFractionUsed: 0.6 })],
    }),
    pool({ modelName: "solo", keys: [key()] }),
    pool({
      modelName: "dry",
      keys: [key({ exhausted: true }), key({ exhausted: true })],
      readySeconds: 30,
      readyIn: "30s",
    }),
    pool({ modelName: "serving-quiet", keys: [key(), key()] }),
  ]);

  it("puts the pools that need attention first and the busiest ahead of the quiet", () => {
    expect(rows.map((row) => row.modelName)).toEqual(["dry", "solo", "serving-busy", "serving-quiet"]);
    expect(rows.map((row) => row.status)).toEqual(["spent", "single-key", "serving", "serving"]);
  });

  it("reports how drained a pool is on average across its keys", () => {
    expect(rows[2].fractionUsed).toBeCloseTo(0.7);
    expect(rows[3].fractionUsed).toBe(0);
  });

  it("carries the countdown and the keys still serving", () => {
    expect(rows[0]).toMatchObject({ keyCount: 2, availableKeyCount: 0, readyIn: "30s" });
    expect(rows[2]).toMatchObject({ keyCount: 2, availableKeyCount: 2, readyIn: null });
  });

  it("has no pools to show when the proxy has none", () => {
    expect(rotationRows([])).toEqual([]);
    expect(rotationRows([pool({ keys: [] })])[0].fractionUsed).toBe(0);
  });
});

const spent = (modelName: string, keys: number, readySeconds: number | null = 30): PoolView =>
  pool({
    modelName,
    keys: Array.from({ length: keys }, () => key({ exhausted: true })),
    readySeconds,
    readyIn: readySeconds == null ? null : `${readySeconds}s`,
  });

describe("attentionItems", () => {
  it("says nothing when every pool is serving and nothing is failing", () => {
    expect(attentionItems(healthy)).toEqual([]);
  });

  it("groups the spent pools into one critical and counts down to the soonest", () => {
    const items = attentionItems({ ...healthy, pools: [spent("flash", 2, 90), spent("haiku", 2, 30)] });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "pools-spent", tone: "critical", title: "2 models have no key with room" });
    expect(items[0].detail).toBe("Every key behind flash and haiku is waiting on a window. Room frees up in 30s.");
    expect(items[0].action).toEqual({ label: "Open Key Rotation", page: "quota" });
  });

  it("tells a one-key pool to add a second key", () => {
    const [item] = attentionItems({ ...healthy, pools: [spent("flash", 1, 12)] });

    expect(item.title).toBe("flash has no key with room");
    expect(item.detail).toBe(
      "Only one key sits behind flash and its quota is spent, so requests fail until room frees up in 12s. Add a second key and the router has somewhere to send them.",
    );
  });

  it("counts the keys a single spent pool is waiting on", () => {
    const [item] = attentionItems({ ...healthy, pools: [spent("flash", 3, 12)] });

    expect(item.detail).toBe("All 3 keys behind flash are waiting on a window. Room frees up in 12s.");
  });

  it("stays honest when the proxy did not say when room frees up", () => {
    const [item] = attentionItems({ ...healthy, pools: [spent("flash", 2, null)] });

    expect(item.detail).toContain("Room frees up as soon as a window rolls over.");
  });

  it("names at most three models and counts the rest", () => {
    const pools = ["a", "b", "c", "d"].map((name) => spent(name, 2));

    expect(attentionItems({ ...healthy, pools })[0].detail).toContain("Every key behind a, b, c and 1 more is");
  });

  it("warns about a pool with a single key and points at where keys are added", () => {
    const pools = [pool({ modelName: "flash", keys: [key()] }), pool({ modelName: "haiku", keys: [key(), key()] })];
    const items = attentionItems({ ...healthy, pools });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "pools-single-key",
      tone: "warning",
      title: "flash has nothing to fail over to",
    });
    expect(items[0].detail).toBe(
      "flash runs on a single key, so a rate limit or an outage on it fails the request instead of moving to another key.",
    );
    expect(items[0].action).toEqual({ label: "Add a key", page: "models" });
  });

  it("groups several single-key models into one warning", () => {
    const pools = [pool({ modelName: "flash", keys: [key()] }), pool({ modelName: "haiku", keys: [key()] })];
    const [item] = attentionItems({ ...healthy, pools });

    expect(item.title).toBe("2 models have nothing to fail over to");
    expect(item.detail).toContain("flash and haiku run on a single key,");
  });

  it("reports a spent one-key pool once, as the critical it is", () => {
    const items = attentionItems({ ...healthy, pools: [spent("flash", 1, 5)] });

    expect(items.map((item) => item.id)).toEqual(["pools-spent"]);
  });

  it("warns when keys carry caps that nothing is counting", () => {
    const quota = overview({ enforced: false, keyCount: 4, unmeteredKeyCount: 1 });
    const items = attentionItems({ ...healthy, quota });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "quota-not-enforced",
      tone: "warning",
      title: "Per-key caps are not being counted",
    });
    expect(items[0].detail).toContain(
      "3 keys carry a per-minute or per-day cap, but nothing counts against those caps",
    );
    expect(items[0].action).toEqual({ label: "Turn enforcement on", page: "quota" });
  });

  it("keeps quiet about enforcement when no key carries a cap at all", () => {
    const quota = overview({ enforced: false, keyCount: 2, unmeteredKeyCount: 2 });

    expect(attentionItems({ ...healthy, quota })).toEqual([]);
  });

  it("reads as a sentence when a single key carries the cap", () => {
    const quota = overview({ enforced: false, keyCount: 1, unmeteredKeyCount: 0 });

    expect(attentionItems({ ...healthy, quota })[0].detail).toContain("1 key carries a per-minute");
  });

  it("needs both a real failure rate and enough requests to call out the range", () => {
    const quiet = attentionItems({ ...healthy, totals: totals({ successful: 17, failed: 2, failureRate: 0.105 }) });
    const rare = attentionItems({ ...healthy, totals: totals({ successful: 181, failed: 19, failureRate: 0.095 }) });

    expect(quiet).toEqual([]);
    expect(rare).toEqual([]);
  });

  it("warns on a failing range and counts the requests it settled", () => {
    const items = attentionItems({ ...healthy, totals: totals({ successful: 18, failed: 2, failureRate: 0.1 }) });

    expect(items[0]).toMatchObject({ id: "range-failures", tone: "warning", title: "10% of requests failed" });
    expect(items[0].detail).toBe("2 of 20 requests came back as a failure in this range.");
    expect(items[0].action).toEqual({ label: "Open Logs", page: "logs" });
  });

  it("escalates to critical once half the requests fail", () => {
    const items = attentionItems({ ...healthy, totals: totals({ successful: 10, failed: 10, failureRate: 0.5 }) });

    expect(items[0]).toMatchObject({ id: "range-failures", tone: "critical", title: "50% of requests failed" });
  });

  it("calls out the worst model and ignores the ones with too few requests to judge", () => {
    const models = [
      modelRow({ name: "flash", successful: 6, failed: 4, failureRate: 0.4 }),
      modelRow({ name: "sonnet", successful: 1, failed: 8, failureRate: 0.888 }),
      modelRow({ name: "haiku", successful: 80, failed: 20, failureRate: 0.2 }),
    ];
    const items = attentionItems({ ...healthy, models });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "model-failures", title: "flash is failing 40% of the time" });
    expect(items[0].detail).toBe(
      "4 of 10 requests to flash failed. A fallback model keeps a harness working while one provider is unhappy.",
    );
  });

  it("puts the criticals above the warnings", () => {
    const items = attentionItems({
      totals: totals({ successful: 10, failed: 10, failureRate: 0.5 }),
      models: [],
      pools: [pool({ modelName: "flash", keys: [key()] })],
      quota: overview({ enforced: false }),
    });

    expect(items.map((item) => item.id)).toEqual(["range-failures", "pools-single-key", "quota-not-enforced"]);
  });
});
