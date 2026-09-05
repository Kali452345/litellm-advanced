"use client";

import { LayoutDashboard } from "lucide-react";
import { useMemo, useState } from "react";

import { breakdownRows, dailySeries, totalsFrom } from "@/app/(dashboard)/_lib/analyticsSummary";
import { rangeQuery, useDailyActivity } from "@/app/(dashboard)/hooks/dailyActivity/useDailyActivity";
import { toOverview, toPoolViews } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";
import { useQuotaUsage } from "@/app/(dashboard)/hooks/quotaUsage/useQuotaUsage";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { PageHeader } from "@/components/shared/PageHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { all_admin_roles } from "@/utils/roles";

import { attentionItems, RANGES, rangeById, rangeFor, rotationRows, topModels } from "../_lib/overviewSummary";
import { OverviewAttention } from "./OverviewAttention";
import { OverviewKpis } from "./OverviewKpis";
import { OverviewRotation } from "./OverviewRotation";
import { OverviewTopModels } from "./OverviewTopModels";
import { OverviewTraffic } from "./OverviewTraffic";

const TOP_MODELS = 5;

export function OverviewView() {
  const { userRole, userId } = useAuthorized();
  const [rangeId, setRangeId] = useState<string>(RANGES[1].id);
  const range = rangeById(rangeId);

  const isAdmin = all_admin_roles.includes(userRole || "");
  const scopedUserId = isAdmin ? null : userId;
  const query = useMemo(() => {
    const { from, to } = rangeFor(range.days, new Date());
    return { ...rangeQuery(from, to), userId: scopedUserId };
  }, [range.days, scopedUserId]);

  const { data, isFetching } = useDailyActivity(query);
  const days = useMemo(() => data ?? [], [data]);

  const totals = useMemo(() => totalsFrom(days), [days]);
  const points = useMemo(() => dailySeries(days), [days]);
  const models = useMemo(() => breakdownRows(days, (breakdown) => breakdown.models), [days]);
  const top = useMemo(() => topModels(models, TOP_MODELS), [models]);

  const { data: usage } = useQuotaUsage();
  const pools = useMemo(() => toPoolViews(usage), [usage]);
  const quota = useMemo(() => toOverview(usage, pools), [usage, pools]);
  const rotation = useMemo(() => rotationRows(pools), [pools]);

  const items = useMemo(() => attentionItems({ totals, models, pools, quota }), [totals, models, pools, quota]);

  return (
    <div className="flex w-full min-w-0 flex-1 flex-col gap-6 p-6">
      <PageHeader
        title="Overview"
        subtitle="What the proxy served, what failed, and which keys it can still route to"
        icon={<LayoutDashboard />}
        utilities={
          <>
            {isFetching && <UiLoadingSpinner className="size-4" />}
            <Tabs value={rangeId} onValueChange={(value) => setRangeId(String(value))}>
              <TabsList variant="line" aria-label="Range">
                {RANGES.map((option) => (
                  <TabsTrigger key={option.id} value={option.id}>
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </>
        }
      />

      <OverviewAttention items={items} />
      <OverviewKpis totals={totals} />
      <OverviewTraffic points={points} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <OverviewTopModels models={top} />
        {isAdmin && <OverviewRotation rows={rotation} />}
      </div>
    </div>
  );
}
