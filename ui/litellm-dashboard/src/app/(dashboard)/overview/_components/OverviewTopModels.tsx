"use client";

import { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@/components/shared/Meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MIGRATED_PAGES, migratedHref } from "@/utils/migratedPages";

import { formatAverage, formatCount, formatPercent, formatUsd } from "@/app/(dashboard)/_lib/format";

import type { ModelShare } from "../_lib/overviewSummary";

const FAILING_AT = 0.1;

interface OverviewTopModelsProps {
  models: readonly ModelShare[];
}

function ModelRow({ model }: { model: ModelShare }) {
  return (
    <Meter value={model.share * 100} max={100} data-testid={`overview-model-${model.name}`}>
      <div className="flex items-baseline justify-between gap-3">
        <MeterLabel className="truncate text-sm font-medium text-foreground">{model.name}</MeterLabel>
        <MeterValue className="shrink-0 text-sm">{() => formatPercent(model.share)}</MeterValue>
      </div>
      <MeterTrack>
        <MeterIndicator tone={model.failureRate >= FAILING_AT ? "warning" : "default"} />
      </MeterTrack>
      <p className="text-xs text-muted-foreground">
        {formatCount(model.requests)} requests, {formatAverage(model.tokensPerRequest)} tokens each,{" "}
        {formatPercent(model.failureRate)} failed, {formatUsd(model.spend)}
      </p>
    </Meter>
  );
}

export function OverviewTopModels({ models }: OverviewTopModelsProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base font-medium">Which models are being used</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Share of requests, how heavy each one was and what it cost
          </p>
        </div>
        <a
          href={migratedHref(MIGRATED_PAGES.analytics)}
          className="shrink-0 text-sm font-medium text-info underline-offset-4 hover:underline"
        >
          Full analytics
        </a>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {models.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No model served a request in this range.</p>
        ) : (
          models.map((model) => <ModelRow key={model.name} model={model} />)
        )}
      </CardContent>
    </Card>
  );
}
