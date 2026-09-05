import type { AnalyticsTotals, BreakdownRow } from "@/app/(dashboard)/_lib/analyticsSummary";
import { formatCount, formatPercent } from "@/app/(dashboard)/_lib/format";
import { formatCountdown, type PoolView, type QuotaOverview } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NAMES = 3;
const RANGE_FAILURE_RATE = 0.1;
const RANGE_FAILURE_CRITICAL_RATE = 0.5;
const RANGE_FAILURE_MIN_REQUESTS = 20;
const MODEL_FAILURE_RATE = 0.25;
const MODEL_FAILURE_MIN_REQUESTS = 10;

export interface RangeOption {
  id: string;
  label: string;
  days: number;
}

export const RANGES = [
  { id: "today", label: "Today", days: 1 },
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
] as const satisfies readonly RangeOption[];

export type RangeId = (typeof RANGES)[number]["id"];

const DEFAULT_RANGE: RangeOption = RANGES[1];

export const rangeById = (id: string): RangeOption => RANGES.find((range) => range.id === id) ?? DEFAULT_RANGE;

export interface DateRange {
  from: Date;
  to: Date;
}

/** The window includes today, so a 7 day range reaches back 6. */
export const rangeFor = (days: number, now: Date): DateRange => ({
  from: new Date(now.getTime() - (days - 1) * DAY_MS),
  to: now,
});

export interface ModelShare {
  name: string;
  requests: number;
  share: number;
  failureRate: number;
  totalTokens: number;
  tokensPerRequest: number;
  spend: number;
}

/** Share is against every model that served a request, not just the ones that made the cut. */
export const topModels = (rows: readonly BreakdownRow[], limit: number): ModelShare[] => {
  const total = rows.reduce((sum, row) => sum + row.requests, 0);
  return rows.slice(0, limit).map((row) => ({
    name: row.name,
    requests: row.requests,
    share: total > 0 ? row.requests / total : 0,
    failureRate: row.failureRate,
    totalTokens: row.totalTokens,
    tokensPerRequest: row.tokensPerRequest,
    spend: row.spend,
  }));
};

export type RotationStatus = "serving" | "single-key" | "spent";

export interface RotationRow {
  modelName: string;
  status: RotationStatus;
  keyCount: number;
  availableKeyCount: number;
  fractionUsed: number;
  readyIn: string | null;
}

const STATUS_ORDER: Record<RotationStatus, number> = { spent: 0, "single-key": 1, serving: 2 };

const statusOf = (pool: PoolView): RotationStatus => {
  if (pool.exhausted) return "spent";
  return pool.keyCount === 1 ? "single-key" : "serving";
};

/** How drained the pool is on average, since the router spends one key down before moving to the next. */
const fractionUsedOf = (pool: PoolView): number =>
  pool.keys.length === 0 ? 0 : pool.keys.reduce((sum, key) => sum + key.tightestFractionUsed, 0) / pool.keys.length;

export const rotationRows = (pools: readonly PoolView[]): RotationRow[] =>
  pools
    .map((pool) => ({
      modelName: pool.modelName,
      status: statusOf(pool),
      keyCount: pool.keyCount,
      availableKeyCount: pool.availableKeyCount,
      fractionUsed: fractionUsedOf(pool),
      readyIn: pool.readyIn,
    }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        b.fractionUsed - a.fractionUsed ||
        a.modelName.localeCompare(b.modelName),
    );

export type AttentionTone = "critical" | "warning";
export type AttentionPage = "quota" | "models" | "logs";

export interface AttentionAction {
  label: string;
  page: AttentionPage;
}

export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  detail: string;
  action: AttentionAction;
}

export interface AttentionInput {
  totals: AnalyticsTotals;
  models: readonly BreakdownRow[];
  pools: readonly PoolView[];
  quota: QuotaOverview;
}

const settledOf = (row: { successful: number; failed: number }): number => row.successful + row.failed;

const nameList = (names: readonly string[]): string => {
  const shown = names.slice(0, MAX_NAMES);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length < 2) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
};

const spentDetail = (spent: readonly PoolView[], free: string): string => {
  const [first] = spent;
  if (spent.length > 1) {
    return `Every key behind ${nameList(spent.map((pool) => pool.modelName))} is waiting on a window. Room frees up ${free}.`;
  }
  if (first.keyCount === 1) {
    return `Only one key sits behind ${first.modelName} and its quota is spent, so requests fail until room frees up ${free}. Add a second key and the router has somewhere to send them.`;
  }
  return `All ${first.keyCount} keys behind ${first.modelName} are waiting on a window. Room frees up ${free}.`;
};

const spentPoolItem = (pools: readonly PoolView[]): AttentionItem | null => {
  const spent = pools.filter((pool) => pool.exhausted);
  if (spent.length === 0) return null;

  const soonest = spent.reduce<number | null>((best, pool) => {
    const seconds = pool.readySeconds;
    if (seconds == null) return best;
    return best == null || seconds < best ? seconds : best;
  }, null);

  return {
    id: "pools-spent",
    tone: "critical",
    title:
      spent.length === 1
        ? `${spent[0].modelName} has no key with room`
        : `${spent.length} models have no key with room`,
    detail: spentDetail(spent, soonest == null ? "as soon as a window rolls over" : `in ${formatCountdown(soonest)}`),
    action: { label: "Open Key Rotation", page: "quota" },
  };
};

const singleKeyItem = (pools: readonly PoolView[]): AttentionItem | null => {
  const lonely = pools.filter((pool) => pool.keyCount === 1 && !pool.exhausted);
  if (lonely.length === 0) return null;

  const names = lonely.map((pool) => pool.modelName);
  return {
    id: "pools-single-key",
    tone: "warning",
    title:
      lonely.length === 1
        ? `${names[0]} has nothing to fail over to`
        : `${lonely.length} models have nothing to fail over to`,
    detail: `${nameList(names)} ${lonely.length === 1 ? "runs" : "run"} on a single key, so a rate limit or an outage on it fails the request instead of moving to another key.`,
    action: { label: "Add a key", page: "models" },
  };
};

const enforcementItem = (quota: QuotaOverview): AttentionItem | null => {
  const metered = quota.keyCount - quota.unmeteredKeyCount;
  if (quota.enforced || metered === 0) return null;

  return {
    id: "quota-not-enforced",
    tone: "warning",
    title: "Per-key caps are not being counted",
    detail: `${formatCount(metered)} ${metered === 1 ? "key carries" : "keys carry"} a per-minute or per-day cap, but nothing counts against those caps, so the provider's own limit is all that stops a request.`,
    action: { label: "Turn enforcement on", page: "quota" },
  };
};

const rangeFailureItem = (totals: AnalyticsTotals): AttentionItem | null => {
  const requests = settledOf(totals);
  if (requests < RANGE_FAILURE_MIN_REQUESTS || totals.failureRate < RANGE_FAILURE_RATE) return null;

  return {
    id: "range-failures",
    tone: totals.failureRate >= RANGE_FAILURE_CRITICAL_RATE ? "critical" : "warning",
    title: `${formatPercent(totals.failureRate)} of requests failed`,
    detail: `${formatCount(totals.failed)} of ${formatCount(requests)} requests came back as a failure in this range.`,
    action: { label: "Open Logs", page: "logs" },
  };
};

const worstModel = (models: readonly BreakdownRow[]): BreakdownRow | null =>
  models
    .filter((row) => settledOf(row) >= MODEL_FAILURE_MIN_REQUESTS && row.failureRate >= MODEL_FAILURE_RATE)
    .reduce<BreakdownRow | null>(
      (worst, row) => (worst == null || row.failureRate > worst.failureRate ? row : worst),
      null,
    );

const modelFailureItem = (models: readonly BreakdownRow[]): AttentionItem | null => {
  const worst = worstModel(models);
  if (worst == null) return null;

  return {
    id: "model-failures",
    tone: "warning",
    title: `${worst.name} is failing ${formatPercent(worst.failureRate)} of the time`,
    detail: `${formatCount(worst.failed)} of ${formatCount(settledOf(worst))} requests to ${worst.name} failed. A fallback model keeps a harness working while one provider is unhappy.`,
    action: { label: "Open Logs", page: "logs" },
  };
};

const TONE_ORDER: Record<AttentionTone, number> = { critical: 0, warning: 1 };

export const attentionItems = ({ totals, models, pools, quota }: AttentionInput): AttentionItem[] =>
  [
    spentPoolItem(pools),
    singleKeyItem(pools),
    enforcementItem(quota),
    rangeFailureItem(totals),
    modelFailureItem(models),
  ]
    .filter((item): item is AttentionItem => item !== null)
    .sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
