import { describe, expect, it } from "vitest";

import { formatAverage, formatCount, formatDay, formatExact, formatPercent, formatUsd } from "./format";

describe("formatCount", () => {
  it.each([
    { value: 0, expected: "0" },
    { value: 42, expected: "42" },
    { value: 9999, expected: "9,999" },
    { value: 10_000, expected: "10K" },
    { value: 12_340, expected: "12.3K" },
    { value: 4_500_000, expected: "4.5M" },
  ])("renders $value as $expected", ({ value, expected }) => {
    expect(formatCount(value)).toBe(expected);
  });

  it("keeps a four-digit count exact, since a request count is read as a number", () => {
    expect(formatCount(1234)).toBe("1,234");
  });
});

describe("formatExact", () => {
  it("never abbreviates, for a figure the reader is meant to compare digit by digit", () => {
    expect(formatExact(4_500_000)).toBe("4,500,000");
  });
});

describe("formatAverage", () => {
  it("keeps one decimal so a per-request average does not round away", () => {
    expect(formatAverage(133.33)).toBe("133.3");
  });
});

describe("formatUsd", () => {
  it.each([
    { value: 0, expected: "$0.00" },
    { value: 12.3456, expected: "$12.35" },
    { value: 1234.5, expected: "$1234.50" },
  ])("renders $value as $expected", ({ value, expected }) => {
    expect(formatUsd(value)).toBe(expected);
  });

  it("keeps a sub-cent cost visible rather than reporting a paid request as free", () => {
    expect(formatUsd(0.000123)).toBe("$0.00012");
  });

  it("shows four decimals between a cent and a dollar, where two would lose the last digit", () => {
    expect(formatUsd(0.0425)).toBe("$0.0425");
  });

  it("abbreviates once the figure is wide enough to break a card", () => {
    expect(formatUsd(24_500)).toBe("$24.5K");
  });
});

describe("formatPercent", () => {
  it.each([
    { fraction: 0, expected: "0%" },
    { fraction: 0.25, expected: "25%" },
    { fraction: 0.1234, expected: "12.3%" },
    { fraction: 1, expected: "100%" },
  ])("renders $fraction as $expected", ({ fraction, expected }) => {
    expect(formatPercent(fraction)).toBe(expected);
  });
});

describe("formatDay", () => {
  it("shortens an iso date to what a dense axis has room for", () => {
    expect(formatDay("2026-09-02")).toBe("Sep 2");
  });

  it("reads the date as UTC, so a day does not shift for a reader west of the meridian", () => {
    expect(formatDay("2026-01-01")).toBe("Jan 1");
  });

  it("passes an unparseable value through instead of rendering Invalid Date", () => {
    expect(formatDay("all-time")).toBe("all-time");
  });
});
