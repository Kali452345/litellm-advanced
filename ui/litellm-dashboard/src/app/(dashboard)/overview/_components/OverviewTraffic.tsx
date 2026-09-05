"use client";

import { useState } from "react";

import { BarChart, type ChartColor } from "@/components/shared/charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { trendRows, type DailyPoint, type TrendField } from "@/app/(dashboard)/_lib/analyticsSummary";
import { formatCount, formatDay } from "@/app/(dashboard)/_lib/format";

interface TrafficSeries {
  id: string;
  label: string;
  fields: readonly TrendField[];
  colors: readonly ChartColor[];
  caption: string;
}

const SERIES: readonly TrafficSeries[] = [
  {
    id: "requests",
    label: "Requests",
    fields: [
      { label: "Succeeded", key: "successful" },
      { label: "Failed", key: "failed" },
    ],
    colors: ["emerald", "rose"],
    caption: "Requests per day, split by whether the proxy completed them",
  },
  {
    id: "tokens",
    label: "Tokens",
    fields: [
      { label: "Prompt", key: "promptTokens" },
      { label: "Completion", key: "completionTokens" },
      { label: "Cached", key: "cacheReadTokens" },
    ],
    colors: ["blue", "violet", "cyan"],
    caption: "Input, output and cache-read tokens per day",
  },
];

interface OverviewTrafficProps {
  points: readonly DailyPoint[];
}

export function OverviewTraffic({ points }: OverviewTrafficProps) {
  const [seriesId, setSeriesId] = useState(SERIES[0].id);
  const series = SERIES.find((candidate) => candidate.id === seriesId) ?? SERIES[0];

  const rows = trendRows(points, series.fields).map((row) => ({ ...row, date: formatDay(String(row.date)) }));
  const categories = series.fields.map((field) => field.label);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base font-medium">Traffic</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{series.caption}</p>
        </div>
        <Tabs value={seriesId} onValueChange={(value) => setSeriesId(String(value))}>
          <TabsList variant="line" aria-label="Traffic metric">
            {SERIES.map((candidate) => (
              <TabsTrigger key={candidate.id} value={candidate.id}>
                {candidate.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        <BarChart
          data={rows}
          index="date"
          categories={categories}
          colors={series.colors}
          valueFormatter={formatCount}
          yAxisWidth={64}
          stack
        />
      </CardContent>
    </Card>
  );
}
