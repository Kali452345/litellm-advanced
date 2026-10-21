"use client";

import SummaryCard from "@/components/shared/SummaryCard";

import type { AnalyticsTotals } from "@/app/(dashboard)/_lib/analyticsSummary";
import { formatAverage, formatCount, formatPercent, formatUsd } from "@/app/(dashboard)/_lib/format";

interface OverviewKpisProps {
  totals: AnalyticsTotals;
}

export function OverviewKpis({ totals }: OverviewKpisProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard
        label="Requests"
        value={formatCount(totals.requests)}
        hint={`${formatCount(totals.successful)} succeeded, ${formatCount(totals.failed)} failed`}
        info="Every request the proxy logged in this range, including the ones it could not complete."
      />
      <SummaryCard
        label="Failed requests"
        value={formatCount(totals.failed)}
        secondary={{ label: "failure rate", value: formatPercent(totals.failureRate) }}
        info="Failures over the requests whose outcome was recorded, so a request still in flight does not flatter the rate."
      />
      <SummaryCard
        label="Total tokens"
        value={formatCount(totals.totalTokens)}
        hint={`${formatCount(totals.promptTokens)} in, ${formatCount(totals.completionTokens)} out`}
        info="Prompt plus completion tokens across the range, cached reads included."
      />
      <SummaryCard
        label="Tokens per request"
        value={formatAverage(totals.tokensPerRequest)}
        hint={`${formatUsd(totals.spendPerRequest)} per successful request`}
        info="Divided by successful requests only, because a failed request carries no tokens."
      />
    </div>
  );
}
