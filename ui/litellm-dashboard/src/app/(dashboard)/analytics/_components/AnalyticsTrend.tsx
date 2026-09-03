"use client";

import { useState } from "react";

import { AreaChart, BarChart, LineChart, type ChartColor } from "@/components/shared/charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { trendRows, type DailyPoint, type TrendField } from "../_lib/analyticsSummary";
import { formatAverage, formatCount, formatDay, formatPercent, formatUsd } from "../_lib/format";

type TrendShape = "area" | "bar" | "line";

interface TrendSeries {
  id: string;
  label: string;
  shape: TrendShape;
  fields: readonly TrendField[];
  colors: readonly ChartColor[];
  format: (value: number) => string;
  caption: string;
}

const SERIES: readonly TrendSeries[] = [
  {
    id: "requests",
    label: "Requests",
    shape: "bar",
    fields: [
      { label: "Succeeded", key: "successful" },
      { label: "Failed", key: "failed" },
    ],
    colors: ["emerald", "rose"],
    format: formatCount,
    caption: "Requests per day, split by whether the proxy completed them",
  },
  {
    id: "tokens",
    label: "Tokens",
    shape: "bar",
    fields: [
      { label: "Prompt", key: "promptTokens" },
      { label: "Completion", key: "completionTokens" },
      { label: "Cached", key: "cacheReadTokens" },
    ],
    colors: ["blue", "violet", "cyan"],
    format: formatCount,
    caption: "Input, output and cache-read tokens per day",
  },
  {
    id: "spend",
    label: "Spend",
    shape: "area",
    fields: [{ label: "Spend", key: "spend" }],
    colors: ["amber"],
    format: formatUsd,
    caption: "What each day cost, priced from the model cost map",
  },
  {
    id: "weight",
    label: "Tokens per request",
    shape: "line",
    fields: [{ label: "Tokens per request", key: "tokensPerRequest" }],
    colors: ["indigo"],
    format: formatAverage,
    caption: "How heavy an average successful request was, day by day",
  },
  {
    id: "failures",
    label: "Failure rate",
    shape: "line",
    fields: [{ label: "Failure rate", key: "failureRate" }],
    colors: ["rose"],
    format: formatPercent,
    caption: "Share of settled requests that failed, day by day",
  },
];

interface AnalyticsTrendProps {
  points: readonly DailyPoint[];
}

export function AnalyticsTrend({ points }: AnalyticsTrendProps) {
  const [seriesId, setSeriesId] = useState(SERIES[0].id);
  const series = SERIES.find((candidate) => candidate.id === seriesId) ?? SERIES[0];

  const rows = trendRows(points, series.fields).map((row) => ({ ...row, date: formatDay(String(row.date)) }));
  const categories = series.fields.map((field) => field.label);
  const shared = {
    data: rows,
    index: "date",
    categories,
    colors: series.colors,
    valueFormatter: series.format,
    yAxisWidth: 64,
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base font-medium">Over time</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{series.caption}</p>
        </div>
        <Tabs value={seriesId} onValueChange={(value) => setSeriesId(String(value))}>
          <TabsList variant="line" aria-label="Metric">
            {SERIES.map((candidate) => (
              <TabsTrigger key={candidate.id} value={candidate.id}>
                {candidate.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {series.shape === "bar" && <BarChart {...shared} stack={categories.length > 1} />}
        {series.shape === "area" && <AreaChart {...shared} showLegend={categories.length > 1} />}
        {series.shape === "line" && <LineChart {...shared} curveType="monotone" showLegend={false} />}
      </CardContent>
    </Card>
  );
}
