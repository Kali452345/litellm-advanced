import { formatCountdown, type KeyView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";

import type { ObservedKeyLimits, ObservedRateLimits, ObservedWindow } from "./useObservedRateLimits";

/**
 * `nothing_fits` is the reading where even the first request of a window was refused, so the
 * ceiling is not something a per-window cap can sit under and rotation is the only way out.
 */
export type CapVerdict = "too_high" | "matches" | "room_to_spare" | "nothing_fits";

export interface ObservedWindowView {
  kind: ObservedWindow["kind"];
  label: string;
  allowed: number;
  configured: number;
  refusals: number;
  verdict: CapVerdict;
  headline: string;
}

export interface ObservedKeyView {
  modelId: string;
  refusals: number;
  lastRefusal: string;
  longestWait: string | null;
  windows: ObservedWindowView[];
}

const WINDOW_LABEL: Record<ObservedWindow["kind"], string> = {
  rpm: "Per minute",
  rpd: "Per day",
};

const CAP_FIELD: Record<ObservedWindow["kind"], string> = {
  rpm: "Requests Per Minute",
  rpd: "Requests Per Day",
};

export const observedByKey = (observed: ObservedRateLimits | undefined): ReadonlyMap<string, ObservedKeyLimits> =>
  new Map((observed?.keys ?? []).map((key) => [key.model_id, key]));

const verdictOf = (allowed: number, configured: number): CapVerdict => {
  if (allowed <= 0) return "nothing_fits";
  if (configured > allowed) return "too_high";
  if (configured === allowed) return "matches";
  return "room_to_spare";
};

const headlineOf = (kind: ObservedWindow["kind"], allowed: number, configured: number, verdict: CapVerdict): string => {
  switch (verdict) {
    case "nothing_fits":
      return "Refused with nothing spent, so its window had not rolled over yet";
    case "too_high":
      return `Allowed ${allowed}, so ${CAP_FIELD[kind]} is ${configured - allowed} too high`;
    case "matches":
      return `Allowed ${allowed}, which is what ${CAP_FIELD[kind]} is set to`;
    case "room_to_spare":
      return `Allowed ${allowed}, so ${CAP_FIELD[kind]} has ${allowed - configured} to spare`;
  }
};

/**
 * The cap to judge against is the one the router is enforcing now, not the one that was
 * configured when the refusal landed, since raising it is exactly what this view is read to do.
 */
const configuredNow = (kind: ObservedWindow["kind"], keyView: KeyView, window: ObservedWindow): number =>
  keyView.windows.find((live) => live.kind === kind)?.limit ?? window.configured_limit;

const toObservedWindowView = (window: ObservedWindow, configured: number): ObservedWindowView => {
  const verdict = verdictOf(window.suggested_limit, configured);
  return {
    kind: window.kind,
    label: WINDOW_LABEL[window.kind],
    allowed: window.suggested_limit,
    configured,
    refusals: window.refusals,
    verdict,
    headline: headlineOf(window.kind, window.suggested_limit, configured, verdict),
  };
};

const elapsed = (at: string, now: Date): string => {
  const seconds = (now.getTime() - new Date(at).getTime()) / 1000;
  return seconds < 60 ? "just now" : `${formatCountdown(seconds)} ago`;
};

const waited = (seconds: number | null | undefined): string | null =>
  seconds == null ? null : formatCountdown(seconds);

export const toObservedKeyView = (limits: ObservedKeyLimits, keyView: KeyView, now: Date): ObservedKeyView => ({
  modelId: limits.model_id,
  refusals: limits.refusals,
  lastRefusal: elapsed(limits.last_refusal, now),
  longestWait: waited(limits.longest_retry_after_seconds),
  windows: (limits.windows ?? []).map((window) =>
    toObservedWindowView(window, configuredNow(window.kind, keyView, window)),
  ),
});

export interface ObservedOverview {
  refusalsRead: number;
  unmeteredRefusals: number;
  capsTooHigh: number;
}

const refusals = (count: number): string => `${count} ${count === 1 ? "refusal" : "refusals"}`;

/**
 * A refusal with nothing counting behind it bounds nothing, so a window full of them has to read
 * as enforcement being off rather than as every cap being correct.
 */
export const observedHint = (overview: ObservedOverview, hours: number): string => {
  if (overview.refusalsRead === 0) return `No rate limit refusal logged in the last ${hours}h`;
  if (overview.refusalsRead === overview.unmeteredRefusals) {
    return `${refusals(overview.refusalsRead)} logged, none with a count behind them`;
  }
  return `Measured from ${overview.refusalsRead - overview.unmeteredRefusals} of ${refusals(overview.refusalsRead)}`;
};

/**
 * How many configured caps sit above what the provider proved it accepts. That is the count worth
 * a summary card: every one of them is a key the router keeps sending to until the provider
 * refuses, which is the failure rotation was set up to avoid.
 */
export const toObservedOverview = (
  observed: ObservedRateLimits | undefined,
  keyViews: readonly KeyView[],
): ObservedOverview => {
  const byModelId = new Map(keyViews.map((keyView) => [keyView.modelId, keyView]));
  return {
    refusalsRead: observed?.refusals_read ?? 0,
    unmeteredRefusals: observed?.unmetered_refusals ?? 0,
    capsTooHigh: (observed?.keys ?? []).reduce((total, limits) => {
      const keyView = byModelId.get(limits.model_id);
      if (!keyView) return total;
      const tooHigh = (limits.windows ?? []).filter(
        (window) => toObservedWindowView(window, configuredNow(window.kind, keyView, window)).verdict === "too_high",
      );
      return total + tooHigh.length;
    }, 0),
  };
};
