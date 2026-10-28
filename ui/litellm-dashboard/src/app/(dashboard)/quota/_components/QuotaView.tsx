"use client";

import { Gauge } from "lucide-react";
import { useCallback, useMemo } from "react";

import {
  observedByKey,
  observedHint,
  toObservedKeyView,
  toObservedOverview,
  type ObservedKeyView,
} from "@/app/(dashboard)/hooks/observedRateLimits/observedLimits";
import {
  OBSERVED_LOOKBACK_HOURS,
  useObservedRateLimits,
} from "@/app/(dashboard)/hooks/observedRateLimits/useObservedRateLimits";
import { toOverview, toPoolViews, type KeyView, type PoolView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";
import { useQuotaUsage } from "@/app/(dashboard)/hooks/quotaUsage/useQuotaUsage";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { AdminOnlyNotice } from "@/components/shared/AdminOnlyNotice";
import { PageHeader } from "@/components/shared/PageHeader";
import SummaryCard from "@/components/shared/SummaryCard";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { UiLoadingSpinner } from "@/components/ui/ui-loading-spinner";
import { all_admin_roles } from "@/utils/roles";

import { QuotaEnforcementCard } from "./QuotaEnforcementCard";
import { QuotaPoolCard } from "./QuotaPoolCard";

interface PoolListProps {
  pools: readonly PoolView[];
  isLoading: boolean;
  observedFor: (keyView: KeyView) => ObservedKeyView | null;
}

function PoolList({ pools, isLoading, observedFor }: PoolListProps) {
  if (pools.length > 0) {
    return (
      <>
        {pools.map((pool) => (
          <QuotaPoolCard key={pool.modelName} pool={pool} observedFor={observedFor} />
        ))}
      </>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-16">
          <UiLoadingSpinner className="size-6" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-16 text-center text-sm text-muted-foreground">
        No model is set up yet. Add one under Provider Keys and every key behind it shows up here.
      </CardContent>
    </Card>
  );
}

export function QuotaView() {
  const { userRole } = useAuthorized();
  const isAdmin = all_admin_roles.includes(userRole || "");

  const { data, isLoading, isFetching } = useQuotaUsage();
  const pools = useMemo(() => toPoolViews(data), [data]);
  const overview = useMemo(() => toOverview(data, pools), [data, pools]);

  const { data: observed } = useObservedRateLimits();
  const observedKeys = useMemo(() => observedByKey(observed), [observed]);
  const observedOverview = useMemo(
    () =>
      toObservedOverview(
        observed,
        pools.flatMap((pool) => pool.keys),
      ),
    [observed, pools],
  );
  const observedFor = useCallback(
    (keyView: KeyView) => {
      const limits = observedKeys.get(keyView.modelId);
      return limits ? toObservedKeyView(limits, keyView, new Date()) : null;
    },
    [observedKeys],
  );

  if (!isAdmin) return <AdminOnlyNotice pageTitle="Key Rotation" />;

  return (
    <div className="flex w-full min-w-0 flex-1 flex-col gap-6 p-6">
      <PageHeader
        title="Key Rotation"
        subtitle="What every key behind every model pool has spent of its per-minute and per-day caps"
        icon={<Gauge />}
        utilities={
          <>
            {isFetching && <UiLoadingSpinner className="size-4" />}
            <Badge variant={overview.enforced ? "secondary" : "outline"}>
              {overview.enforced ? "Quota enforced" : "Quota not enforced"}
            </Badge>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <SummaryCard
          label="Pools"
          value={String(overview.poolCount)}
          hint="One per model name, however many keys sit behind it"
        />
        <SummaryCard
          label="Keys with room"
          value={`${overview.availableKeyCount} / ${overview.keyCount}`}
          hint="Keys the router can still send to"
          info="A key has room when neither its per-minute nor its per-day window is spent."
        />
        <SummaryCard
          label="Pools fully spent"
          value={String(overview.exhaustedPoolCount)}
          hint="Every key in the pool is waiting on a window"
          info="A pool is fully spent when no key in it has room. Requests to that model fail over to whatever the router falls back to."
        />
        <SummaryCard
          label="Keys without a cap"
          value={String(overview.unmeteredKeyCount)}
          hint="Used without a quota check"
          info="A key with no rpm or rpd limit set is never held back, so the provider's own rate limit is the only thing stopping it."
        />
        <SummaryCard
          label="Caps set too high"
          value={String(observedOverview.capsTooHigh)}
          hint={observedHint(observedOverview, OBSERVED_LOOKBACK_HOURS)}
          info="A provider that refuses a key before its own cap is reached proves the cap is above what that key really allows. This is measured from refusals the proxy logged, so it only counts while quota routing is enforcing."
        />
      </div>

      <QuotaEnforcementCard live={{ enforced: overview.enforced, maxWaitSeconds: overview.maxWaitSeconds }} />

      <PoolList pools={pools} isLoading={isLoading} observedFor={observedFor} />
    </div>
  );
}
