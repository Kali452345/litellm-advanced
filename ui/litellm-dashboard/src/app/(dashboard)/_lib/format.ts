const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ONE_DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Counts stay exact until they are wide enough to crowd a chart axis or a card. */
export const formatCount = (value: number): string =>
  Math.abs(value) < 10_000 ? PLAIN.format(value) : COMPACT.format(value);

export const formatExact = (value: number): string => PLAIN.format(value);

export const formatAverage = (value: number): string => ONE_DECIMAL.format(value);

/**
 * Spend down to a tenth of a cent. A per-request cost is often a fraction of a cent, and
 * rounding it to two decimals would report a request that cost money as free.
 */
export const formatUsd = (value: number): string => {
  if (value === 0) return "$0.00";
  const magnitude = Math.abs(value);
  if (magnitude < 0.01) return `$${value.toFixed(5)}`;
  if (magnitude < 1) return `$${value.toFixed(4)}`;
  if (magnitude < 10_000) return `$${value.toFixed(2)}`;
  return `$${COMPACT.format(value)}`;
};

export const formatPercent = (fraction: number): string => `${ONE_DECIMAL.format(fraction * 100)}%`;

/** `2026-09-02` as `Sep 2`, which is what a dense time axis has room for. */
export const formatDay = (isoDate: string): string => {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
};
