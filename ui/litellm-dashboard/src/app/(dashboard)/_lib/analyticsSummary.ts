import type { components } from "@/lib/http/schema";

export type DailyData = components["schemas"]["DailySpendData"];
export type SpendMetrics = components["schemas"]["SpendMetrics"];
export type BreakdownMetrics = components["schemas"]["BreakdownMetrics"];
export type MetricWithMetadata = components["schemas"]["MetricWithMetadata"];

export interface AnalyticsTotals {
  requests: number;
  successful: number;
  failed: number;
  failureRate: number;
  spend: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRate: number;
  tokensPerRequest: number;
  promptTokensPerRequest: number;
  completionTokensPerRequest: number;
  spendPerRequest: number;
}

export type DailyPoint = {
  date: string;
  requests: number;
  successful: number;
  failed: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  spend: number;
  tokensPerRequest: number;
  failureRate: number;
};

export type DailyMetricKey = Exclude<keyof DailyPoint, "date">;

export type BreakdownRow = {
  name: string;
  requests: number;
  successful: number;
  failed: number;
  failureRate: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerRequest: number;
  spend: number;
};

export type ChartRow = Record<string, string | number>;

export interface TrendField {
  label: string;
  key: DailyMetricKey;
}

const ratio = (numerator: number, denominator: number): number => (denominator > 0 ? numerator / denominator : 0);

/**
 * A failed request carries no tokens and no cost, so dividing by every request
 * understates what a working request actually consumes.
 */
const perRequest = (total: number, successful: number): number => ratio(total, successful);

const EMPTY_METRICS: SpendMetrics = {
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
};

const addMetrics = (a: SpendMetrics, b: SpendMetrics): SpendMetrics => ({
  ...EMPTY_METRICS,
  spend: a.spend + b.spend,
  prompt_tokens: a.prompt_tokens + b.prompt_tokens,
  completion_tokens: a.completion_tokens + b.completion_tokens,
  total_tokens: a.total_tokens + b.total_tokens,
  api_requests: a.api_requests + b.api_requests,
  successful_requests: a.successful_requests + b.successful_requests,
  failed_requests: a.failed_requests + b.failed_requests,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
});

const sumMetrics = (all: readonly SpendMetrics[]): SpendMetrics => all.reduce(addMetrics, EMPTY_METRICS);

/** Requests whose outcome was recorded, which is the only honest denominator for a failure rate. */
const settled = (metrics: SpendMetrics): number => metrics.successful_requests + metrics.failed_requests;

export const totalsFrom = (days: readonly DailyData[]): AnalyticsTotals => {
  const metrics = sumMetrics(days.map((day) => day.metrics));
  return {
    requests: metrics.api_requests,
    successful: metrics.successful_requests,
    failed: metrics.failed_requests,
    failureRate: ratio(metrics.failed_requests, settled(metrics)),
    spend: metrics.spend,
    totalTokens: metrics.total_tokens,
    promptTokens: metrics.prompt_tokens,
    completionTokens: metrics.completion_tokens,
    cacheReadTokens: metrics.cache_read_input_tokens,
    cacheCreationTokens: metrics.cache_creation_input_tokens,
    cacheHitRate: ratio(metrics.cache_read_input_tokens, metrics.prompt_tokens + metrics.cache_read_input_tokens),
    tokensPerRequest: perRequest(metrics.total_tokens, metrics.successful_requests),
    promptTokensPerRequest: perRequest(metrics.prompt_tokens, metrics.successful_requests),
    completionTokensPerRequest: perRequest(metrics.completion_tokens, metrics.successful_requests),
    spendPerRequest: perRequest(metrics.spend, metrics.successful_requests),
  };
};

export const dailySeries = (days: readonly DailyData[]): DailyPoint[] =>
  [...days]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, metrics }) => ({
      date,
      requests: metrics.api_requests,
      successful: metrics.successful_requests,
      failed: metrics.failed_requests,
      promptTokens: metrics.prompt_tokens,
      completionTokens: metrics.completion_tokens,
      cacheReadTokens: metrics.cache_read_input_tokens,
      totalTokens: metrics.total_tokens,
      spend: metrics.spend,
      tokensPerRequest: perRequest(metrics.total_tokens, metrics.successful_requests),
      failureRate: ratio(metrics.failed_requests, settled(metrics)),
    }));

const toRow = (name: string, metrics: SpendMetrics): BreakdownRow => ({
  name,
  requests: metrics.api_requests,
  successful: metrics.successful_requests,
  failed: metrics.failed_requests,
  failureRate: ratio(metrics.failed_requests, settled(metrics)),
  totalTokens: metrics.total_tokens,
  promptTokens: metrics.prompt_tokens,
  completionTokens: metrics.completion_tokens,
  tokensPerRequest: perRequest(metrics.total_tokens, metrics.successful_requests),
  spend: metrics.spend,
});

const byRequestsDescending = (a: BreakdownRow, b: BreakdownRow): number =>
  b.requests - a.requests || b.totalTokens - a.totalTokens || a.name.localeCompare(b.name);

const collect = (
  days: readonly DailyData[],
  pick: (breakdown: BreakdownMetrics) => Record<string, { metrics: SpendMetrics }> | undefined,
): Map<string, SpendMetrics[]> =>
  days
    .flatMap((day) => Object.entries(pick(day.breakdown ?? {}) ?? {}))
    .reduce(
      (buckets, [name, entry]) => buckets.set(name, [...(buckets.get(name) ?? []), entry.metrics]),
      new Map<string, SpendMetrics[]>(),
    );

export const breakdownRows = (
  days: readonly DailyData[],
  pick: (breakdown: BreakdownMetrics) => Record<string, MetricWithMetadata> | undefined,
): BreakdownRow[] =>
  Array.from(collect(days, pick), ([name, metrics]) => toRow(name, sumMetrics(metrics))).sort(byRequestsDescending);

/** A key with no alias is identified by its hash, shortened to stay readable in a table cell. */
export const apiKeyRows = (days: readonly DailyData[]): BreakdownRow[] => {
  const aliases = days
    .flatMap((day) => Object.entries(day.breakdown?.api_keys ?? {}))
    .reduce(
      (names, [hash, entry]) => (entry.metadata?.key_alias ? names.set(hash, entry.metadata.key_alias) : names),
      new Map<string, string>(),
    );

  return Array.from(collect(days, (breakdown) => breakdown.api_keys), ([hash, metrics]) =>
    toRow(aliases.get(hash) ?? `${hash.slice(0, 10)}...`, sumMetrics(metrics)),
  ).sort(byRequestsDescending);
};

/**
 * Chart rows keyed by the label the legend shows, because the chart wrappers use a
 * category name as both the data key and its label.
 */
export const trendRows = (points: readonly DailyPoint[], fields: readonly TrendField[]): ChartRow[] =>
  points.map((point) => ({
    date: point.date,
    ...Object.fromEntries(fields.map(({ label, key }) => [label, point[key]])),
  }));

export const rankRows = (rows: readonly BreakdownRow[], label: string, key: keyof BreakdownRow, top: number): ChartRow[] =>
  rows.slice(0, top).map((row) => ({ name: row.name, [label]: row[key] }));
