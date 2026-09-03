"use client";

import { ChartNoAxesColumn } from "lucide-react";
import { useMemo, useState } from "react";

import { rangeQuery, useDailyActivity } from "@/app/(dashboard)/hooks/dailyActivity/useDailyActivity";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import AdvancedDatePicker from "@/components/shared/advanced_date_picker";
import type { DateRangePickerValue } from "@/components/shared/date_picker_types";
import { PageHeader } from "@/components/shared/PageHeader";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { all_admin_roles } from "@/utils/roles";

import { apiKeyRows, breakdownRows, dailySeries, totalsFrom } from "@/app/(dashboard)/_lib/analyticsSummary";
import { AnalyticsBreakdown, type BreakdownBucket } from "./AnalyticsBreakdown";
import { AnalyticsKpis } from "./AnalyticsKpis";
import { AnalyticsTrend } from "./AnalyticsTrend";

const DEFAULT_RANGE_DAYS = 7;

export function AnalyticsView() {
  const { userRole, userId } = useAuthorized();
  const [range, setRange] = useState<DateRangePickerValue>(() => ({
    from: new Date(Date.now() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000),
    to: new Date(),
  }));

  const scopedUserId = all_admin_roles.includes(userRole || "") ? null : userId;
  const query = useMemo(
    () => ({ ...rangeQuery(range.from ?? new Date(), range.to ?? new Date()), userId: scopedUserId }),
    [range.from, range.to, scopedUserId],
  );

  const { data, isLoading, isFetching } = useDailyActivity(query);
  const days = data ?? [];

  const totals = useMemo(() => totalsFrom(days), [days]);
  const points = useMemo(() => dailySeries(days), [days]);
  const buckets = useMemo<readonly BreakdownBucket[]>(
    () => [
      {
        id: "models",
        label: "Models",
        nameTitle: "Model",
        rows: breakdownRows(days, (breakdown) => breakdown.models),
        empty: "No model served a request in this range.",
      },
      {
        id: "providers",
        label: "Providers",
        nameTitle: "Provider",
        rows: breakdownRows(days, (breakdown) => breakdown.providers),
        empty: "No provider served a request in this range.",
      },
      {
        id: "keys",
        label: "API keys",
        nameTitle: "Key",
        rows: apiKeyRows(days),
        empty: "No key made a request in this range.",
      },
      {
        id: "endpoints",
        label: "Endpoints",
        nameTitle: "Endpoint",
        rows: breakdownRows(days, (breakdown) => breakdown.endpoints),
        empty: "This proxy did not record a per-endpoint breakdown for this range.",
      },
    ],
    [days],
  );

  return (
    <div className="flex w-full min-w-0 flex-1 flex-col gap-6 p-6">
      <PageHeader
        title="Analytics"
        subtitle="Requests, failures, tokens and cost across every model and key the proxy routed to"
        icon={<ChartNoAxesColumn />}
        utilities={
          <>
            {isFetching && <UiLoadingSpinner className="size-4" />}
            <AdvancedDatePicker value={range} onValueChange={setRange} />
          </>
        }
      />

      <AnalyticsKpis totals={totals} />
      <AnalyticsTrend points={points} />
      <AnalyticsBreakdown buckets={buckets} isLoading={isLoading} />
    </div>
  );
}
