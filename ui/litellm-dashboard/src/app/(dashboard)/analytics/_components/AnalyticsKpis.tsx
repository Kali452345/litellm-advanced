"use client";

import SummaryCard from "@/components/shared/SummaryCard";

import type { AnalyticsTotals } from "../_lib/analyticsSummary";
import { formatAverage, formatCount, formatExact, formatPercent, formatUsd } from "../_lib/format";

interface AnalyticsKpisProps {
  totals: AnalyticsTotals;
}

export function AnalyticsKpis({ totals }: AnalyticsKpisProps) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard
        label="Requests"
        value={formatCount(totals.requests)}
        hint={`${formatCount(totals.successful)} succeeded, ${formatCount(totals.failed)} failed`}
        info="Every request the proxy logged in this range, including the ones it could not complete."
      />
      <SummaryCard
        label="Failure rate"
        value={formatPercent(totals.failureRate)}
        secondary={{ label: "failed", value: formatCount(totals.failed) }}
        info="Failed requests over the requests whose outcome was recorded, so a request still in flight does not flatter the rate."
      />
      <SummaryCard
        label="Total tokens"
        value={formatCount(totals.totalTokens)}
        hint={`${formatCount(totals.promptTokens)} in, ${formatCount(totals.completionTokens)} out`}
        info="Prompt plus completion tokens across the range."
      />
      <SummaryCard
        label="Tokens per request"
        value={formatAverage(totals.tokensPerRequest)}
        hint={`${formatAverage(totals.promptTokensPerRequest)} in, ${formatAverage(totals.completionTokensPerRequest)} out`}
        info="Divided by successful requests only, because a failed request carries no tokens."
      />
      <SummaryCard
        label="Spend"
        value={formatUsd(totals.spend)}
        hint={`${formatUsd(totals.spendPerRequest)} per successful request`}
        info="What the proxy priced this range at, from the model cost map."
      />
      <SummaryCard
        label="Cache hit rate"
        value={formatPercent(totals.cacheHitRate)}
        secondary={{ label: "cached tokens", value: formatCount(totals.cacheReadTokens) }}
        info="Cache-read tokens over every input token, cached or not. A harness that keeps hitting the same key should sit high here."
      />
      <SummaryCard
        label="Cache writes"
        value={formatCount(totals.cacheCreationTokens)}
        hint="tokens written to the provider cache"
        info="Tokens billed to create a cache entry. A rising figure with a flat hit rate means the cache is being rebuilt instead of read."
      />
      <SummaryCard
        label="Prompt / completion"
        value={formatExact(totals.promptTokens)}
        secondary={{ label: "completion", value: formatExact(totals.completionTokens) }}
        info="The exact split, for comparing against a provider's own bill."
      />
    </div>
  );
}
