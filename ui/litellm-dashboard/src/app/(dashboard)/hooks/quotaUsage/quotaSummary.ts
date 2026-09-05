import type { KeyQuotaUsage, ModelQuotaUsage, PoolQuotaUsage, QuotaWindowUsage } from "./useQuotaUsage";

export interface WindowView {
  kind: QuotaWindowUsage["kind"];
  label: string;
  used: number;
  limit: number;
  remaining: number;
  fractionUsed: number;
  spent: boolean;
  resetsIn: string;
  timezone: string;
}

export interface KeyView {
  modelId: string;
  litellmModel: string;
  provider: string;
  apiBase: string | null;
  exhausted: boolean;
  metered: boolean;
  windows: WindowView[];
  readyIn: string | null;
  tightestFractionUsed: number;
}

export interface PoolView {
  modelName: string;
  exhausted: boolean;
  keys: KeyView[];
  keyCount: number;
  availableKeyCount: number;
  meteredKeyCount: number;
  readySeconds: number | null;
  readyIn: string | null;
}

export interface QuotaOverview {
  enforced: boolean;
  maxWaitSeconds: number | null;
  poolCount: number;
  keyCount: number;
  availableKeyCount: number;
  exhaustedPoolCount: number;
  unmeteredKeyCount: number;
}

const WINDOW_LABEL: Record<QuotaWindowUsage["kind"], string> = {
  rpm: "Per minute",
  rpd: "Per day",
};

export const formatCountdown = (seconds: number): string => {
  if (seconds <= 0) return "now";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.ceil(seconds % 60);
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

/** A limit of zero would divide by zero, and reports as fully spent because it is. */
const fractionUsed = (window: QuotaWindowUsage): number =>
  window.limit <= 0 ? 1 : Math.min(1, Math.max(0, window.used / window.limit));

export const toWindowView = (window: QuotaWindowUsage): WindowView => ({
  kind: window.kind,
  label: WINDOW_LABEL[window.kind],
  used: window.used,
  limit: window.limit,
  remaining: window.remaining,
  fractionUsed: fractionUsed(window),
  spent: window.remaining <= 0,
  resetsIn: formatCountdown(window.seconds_until_reset),
  timezone: window.timezone,
});

/**
 * The provider a key talks to. `litellm_model` carries the prefix the router resolved
 * ("openai/gpt-4o-mini"); a bare model string means the provider was inferred, so the
 * base url is the only thing left that identifies it.
 */
export const providerOf = (key: KeyQuotaUsage): string => {
  const slash = key.litellm_model.indexOf("/");
  if (slash > 0) return key.litellm_model.slice(0, slash);
  if (key.api_base) {
    try {
      return new URL(key.api_base).host;
    } catch {
      return key.api_base;
    }
  }
  return "unknown";
};

export const toKeyView = (key: KeyQuotaUsage): KeyView => {
  const windows = key.windows.map(toWindowView);
  return {
    modelId: key.model_id,
    litellmModel: key.litellm_model,
    provider: providerOf(key),
    apiBase: key.api_base ?? null,
    exhausted: key.exhausted,
    metered: windows.length > 0,
    windows,
    readyIn: key.seconds_until_room == null ? null : formatCountdown(key.seconds_until_room),
    tightestFractionUsed: windows.reduce((tightest, window) => Math.max(tightest, window.fractionUsed), 0),
  };
};

export const toPoolView = (pool: PoolQuotaUsage): PoolView => {
  const keys = pool.keys.map(toKeyView);
  const soonestRoom = pool.keys.reduce<number | null>((soonest, key) => {
    const seconds = key.seconds_until_room;
    if (seconds == null) return soonest;
    return soonest == null || seconds < soonest ? seconds : soonest;
  }, null);

  return {
    modelName: pool.model_name,
    exhausted: pool.exhausted,
    keys,
    keyCount: keys.length,
    availableKeyCount: keys.filter((key) => !key.exhausted).length,
    meteredKeyCount: keys.filter((key) => key.metered).length,
    readySeconds: pool.exhausted ? soonestRoom : null,
    readyIn: pool.exhausted && soonestRoom != null ? formatCountdown(soonestRoom) : null,
  };
};

export const toPoolViews = (usage: ModelQuotaUsage | undefined): PoolView[] =>
  (usage?.pools ?? []).map(toPoolView).sort((a, b) => a.modelName.localeCompare(b.modelName));

export const toOverview = (usage: ModelQuotaUsage | undefined, pools: PoolView[]): QuotaOverview => ({
  enforced: usage?.enforced ?? false,
  maxWaitSeconds: usage?.max_wait_seconds ?? null,
  poolCount: pools.length,
  keyCount: pools.reduce((total, pool) => total + pool.keyCount, 0),
  availableKeyCount: pools.reduce((total, pool) => total + pool.availableKeyCount, 0),
  exhaustedPoolCount: pools.filter((pool) => pool.exhausted).length,
  unmeteredKeyCount: pools.reduce((total, pool) => total + (pool.keyCount - pool.meteredKeyCount), 0),
});
