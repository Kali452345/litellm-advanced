import { describe, expect, it } from "vitest";

import type { BreakdownMetrics, DailyData, MetricWithMetadata, SpendMetrics } from "./analyticsSummary";
import { apiKeyRows, breakdownRows, dailySeries, rankRows, totalsFrom, trendRows } from "./analyticsSummary";

const metrics = (over: Partial<SpendMetrics> = {}): SpendMetrics => ({
  spend: 0,
  flat_cost: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  api_requests: 0,
  successful_requests: 0,
  failed_requests: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  compression_saved_tokens: 0,
  compression_savings_spend: 0,
  prompt_caching_savings_spend: 0,
  gateway_injected_caching_savings_spend: 0,
  autorouter_savings_spend: 0,
  ...over,
});

const entry = (over: Partial<SpendMetrics> = {}): MetricWithMetadata => ({
  metrics: metrics(over),
  metadata: {},
  api_key_breakdown: {},
});

const breakdown = (over: Partial<BreakdownMetrics> = {}): BreakdownMetrics => ({
  models: {},
  model_groups: {},
  mcp_servers: {},
  providers: {},
  api_keys: {},
  entities: {},
  ...over,
});
const day = (date: string, over: Partial<SpendMetrics> = {}, parts: Partial<BreakdownMetrics> = {}): DailyData => ({
  date,
  metrics: metrics(over),
  breakdown: breakdown(parts),
});

describe("totalsFrom", () => {
  it("sums every metric across the range", () => {
    const totals = totalsFrom([
      day("2026-09-01", {
        api_requests: 10,
        successful_requests: 9,
        failed_requests: 1,
        prompt_tokens: 900,
        completion_tokens: 300,
        total_tokens: 1200,
        spend: 0.5,
      }),
      day("2026-09-02", {
        api_requests: 6,
        successful_requests: 3,
        failed_requests: 3,
        prompt_tokens: 300,
        completion_tokens: 100,
        total_tokens: 400,
        spend: 0.25,
      }),
    ]);

    expect(totals.requests).toBe(16);
    expect(totals.successful).toBe(12);
    expect(totals.failed).toBe(4);
    expect(totals.totalTokens).toBe(1600);
    expect(totals.promptTokens).toBe(1200);
    expect(totals.completionTokens).toBe(400);
    expect(totals.spend).toBeCloseTo(0.75);
  });

  it("rates failures against requests that actually settled, not the request count", () => {
    const totals = totalsFrom([day("2026-09-01", { api_requests: 100, successful_requests: 6, failed_requests: 2 })]);

    expect(totals.failureRate).toBeCloseTo(0.25);
  });

  it("divides tokens by successful requests, since a failed request carries none", () => {
    const totals = totalsFrom([
      day("2026-09-01", {
        api_requests: 10,
        successful_requests: 4,
        failed_requests: 6,
        total_tokens: 800,
        prompt_tokens: 600,
        completion_tokens: 200,
        spend: 2,
      }),
    ]);

    expect(totals.tokensPerRequest).toBe(200);
    expect(totals.promptTokensPerRequest).toBe(150);
    expect(totals.completionTokensPerRequest).toBe(50);
    expect(totals.spendPerRequest).toBe(0.5);
  });

  it("reports zero rather than NaN when nothing succeeded", () => {
    const totals = totalsFrom([day("2026-09-01", { api_requests: 3, failed_requests: 3, total_tokens: 0 })]);

    expect(totals.tokensPerRequest).toBe(0);
    expect(totals.spendPerRequest).toBe(0);
    expect(totals.failureRate).toBe(1);
  });

  it("reports zero rather than NaN for an empty range", () => {
    const totals = totalsFrom([]);

    expect(totals.requests).toBe(0);
    expect(totals.failureRate).toBe(0);
    expect(totals.cacheHitRate).toBe(0);
    expect(totals.tokensPerRequest).toBe(0);
  });

  it("rates cache hits against every input token, cached or not", () => {
    const totals = totalsFrom([
      day("2026-09-01", { successful_requests: 1, prompt_tokens: 250, cache_read_input_tokens: 750 }),
    ]);

    expect(totals.cacheHitRate).toBeCloseTo(0.75);
  });
});

describe("dailySeries", () => {
  it("orders points by date so a chart reads left to right regardless of fetch order", () => {
    const series = dailySeries([day("2026-09-03"), day("2026-09-01"), day("2026-09-02")]);

    expect(series.map((point) => point.date)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("carries per-day derived rates, not just raw counts", () => {
    const series = dailySeries([
      day("2026-09-01", { api_requests: 4, successful_requests: 2, failed_requests: 2, total_tokens: 500 }),
    ]);

    expect(series[0].failureRate).toBeCloseTo(0.5);
    expect(series[0].tokensPerRequest).toBe(250);
  });

  it("leaves the caller's array untouched", () => {
    const days = [day("2026-09-03"), day("2026-09-01")];
    dailySeries(days);

    expect(days.map((d) => d.date)).toEqual(["2026-09-03", "2026-09-01"]);
  });
});

describe("breakdownRows", () => {
  it("merges the same model across days into one row", () => {
    const rows = breakdownRows(
      [
        day(
          "2026-09-01",
          {},
          { models: { "gpt-4o-mini": entry({ api_requests: 3, successful_requests: 3, total_tokens: 300 }) } },
        ),
        day(
          "2026-09-02",
          {},
          { models: { "gpt-4o-mini": entry({ api_requests: 2, successful_requests: 2, total_tokens: 200 }) } },
        ),
      ],
      (b) => b.models,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "gpt-4o-mini", requests: 5, totalTokens: 500, tokensPerRequest: 100 });
  });

  it("ranks the busiest model first", () => {
    const rows = breakdownRows(
      [
        day(
          "2026-09-01",
          {},
          {
            models: {
              quiet: entry({ api_requests: 1 }),
              busy: entry({ api_requests: 50 }),
              middling: entry({ api_requests: 7 }),
            },
          },
        ),
      ],
      (b) => b.models,
    );

    expect(rows.map((row) => row.name)).toEqual(["busy", "middling", "quiet"]);
  });

  it("breaks a request-count tie on tokens so the order does not wobble", () => {
    const rows = breakdownRows(
      [
        day(
          "2026-09-01",
          {},
          {
            models: {
              light: entry({ api_requests: 5, total_tokens: 10 }),
              heavy: entry({ api_requests: 5, total_tokens: 9000 }),
            },
          },
        ),
      ],
      (b) => b.models,
    );

    expect(rows.map((row) => row.name)).toEqual(["heavy", "light"]);
  });

  it("reads whichever bucket the caller picks", () => {
    const days = [
      day("2026-09-01", {}, { providers: { openai: entry({ api_requests: 4 }) }, models: { m: entry() } }),
    ];

    expect(breakdownRows(days, (b) => b.providers).map((row) => row.name)).toEqual(["openai"]);
  });

  it("returns nothing for a bucket the backend did not send", () => {
    expect(breakdownRows([day("2026-09-01")], (b) => b.endpoints)).toEqual([]);
  });

  it("carries a per-row failure rate so a single bad model is visible", () => {
    const rows = breakdownRows(
      [
        day(
          "2026-09-01",
          {},
          { models: { flaky: entry({ api_requests: 10, successful_requests: 6, failed_requests: 4 }) } },
        ),
      ],
      (b) => b.models,
    );

    expect(rows[0].failureRate).toBeCloseTo(0.4);
  });
});

describe("apiKeyRows", () => {
  const keyEntry = (alias: string | null, over: Partial<SpendMetrics> = {}) => ({
    metrics: metrics(over),
    metadata: { key_alias: alias, team_id: null },
  });

  it("labels a key by its alias", () => {
    const rows = apiKeyRows([
      day("2026-09-01", {}, { api_keys: { abcdef0123456789: keyEntry("harness-a", { api_requests: 3 }) } }),
    ]);

    expect(rows[0].name).toBe("harness-a");
    expect(rows[0].requests).toBe(3);
  });

  it("shortens an unaliased key hash instead of rendering the whole thing", () => {
    const rows = apiKeyRows([
      day("2026-09-01", {}, { api_keys: { abcdef0123456789: keyEntry(null, { api_requests: 1 }) } }),
    ]);

    expect(rows[0].name).toBe("abcdef0123...");
  });

  it("still finds the alias when only a later day carries it", () => {
    const rows = apiKeyRows([
      day("2026-09-01", {}, { api_keys: { abcdef0123456789: keyEntry(null, { api_requests: 1 }) } }),
      day("2026-09-02", {}, { api_keys: { abcdef0123456789: keyEntry("harness-b", { api_requests: 1 }) } }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("harness-b");
    expect(rows[0].requests).toBe(2);
  });
});

describe("trendRows", () => {
  it("keys each value by the label the legend shows, since the chart reuses one name for both", () => {
    const points = dailySeries([day("2026-09-01", { successful_requests: 7, failed_requests: 2 })]);

    expect(
      trendRows(points, [
        { label: "Succeeded", key: "successful" },
        { label: "Failed", key: "failed" },
      ]),
    ).toEqual([{ date: "2026-09-01", Succeeded: 7, Failed: 2 }]);
  });

  it("carries only the requested fields, so a chart cannot pick up a series nobody asked for", () => {
    const points = dailySeries([day("2026-09-01", { spend: 3, total_tokens: 90 })]);

    expect(Object.keys(trendRows(points, [{ label: "Spend", key: "spend" }])[0])).toEqual(["date", "Spend"]);
  });
});

describe("rankRows", () => {
  const rows = breakdownRows(
    [
      day(
        "2026-09-01",
        {},
        {
          models: {
            a: entry({ api_requests: 30 }),
            b: entry({ api_requests: 20 }),
            c: entry({ api_requests: 10 }),
          },
        },
      ),
    ],
    (b) => b.models,
  );

  it("keeps only the top slice, because a long tail makes a bar chart unreadable", () => {
    expect(rankRows(rows, "Requests", "requests", 2)).toEqual([
      { name: "a", Requests: 30 },
      { name: "b", Requests: 20 },
    ]);
  });

  it("reads whichever metric the caller ranks on", () => {
    expect(rankRows(rows, "Spend", "spend", 1)).toEqual([{ name: "a", Spend: 0 }]);
  });
});
