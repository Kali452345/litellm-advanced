"use client";

import { useState } from "react";

import { BarChart } from "@/components/shared/charts";
import { DataTable } from "@/components/shared/DataTable";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { rankRows, type BreakdownRow } from "../_lib/analyticsSummary";
import { formatCount, formatUsd } from "../_lib/format";
import { breakdownColumns } from "./BreakdownColumns";

const TOP_N = 10;

const RANKINGS = [
  { id: "requests", label: "Requests", key: "requests", format: formatCount },
  { id: "totalTokens", label: "Tokens", key: "totalTokens", format: formatCount },
  { id: "spend", label: "Spend", key: "spend", format: formatUsd },
] as const satisfies readonly {
  id: string;
  label: string;
  key: keyof BreakdownRow;
  format: (value: number) => string;
}[];

export interface BreakdownBucket {
  id: string;
  label: string;
  nameTitle: string;
  rows: BreakdownRow[];
  empty: string;
}

interface AnalyticsBreakdownProps {
  buckets: readonly BreakdownBucket[];
  isLoading: boolean;
}

export function AnalyticsBreakdown({ buckets, isLoading }: AnalyticsBreakdownProps) {
  const [bucketId, setBucketId] = useState(buckets[0]?.id ?? "");
  const [rankingId, setRankingId] = useState<(typeof RANKINGS)[number]["id"]>("requests");

  const bucket = buckets.find((candidate) => candidate.id === bucketId) ?? buckets[0];
  const ranking = RANKINGS.find((candidate) => candidate.id === rankingId) ?? RANKINGS[0];
  if (!bucket) return null;

  const ranked = rankRows(bucket.rows, ranking.label, ranking.key, TOP_N);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="text-base font-medium">Breakdown</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Every {bucket.nameTitle.toLowerCase()} that served a request in this range
          </p>
        </div>
        <Tabs value={bucketId} onValueChange={(value) => setBucketId(String(value))}>
          <TabsList variant="line" aria-label="Breakdown">
            {buckets.map((candidate) => (
              <TabsTrigger key={candidate.id} value={candidate.id}>
                {candidate.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent className="space-y-6">
        {bucket.rows.length === 0 && !isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{bucket.empty}</p>
        ) : (
          <>
            <div>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Top {Math.min(TOP_N, bucket.rows.length)} by {ranking.label.toLowerCase()}
                </p>
                <Tabs value={rankingId} onValueChange={(value) => setRankingId(value as typeof rankingId)}>
                  <TabsList aria-label="Rank by">
                    {RANKINGS.map((candidate) => (
                      <TabsTrigger key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
              <BarChart
                data={ranked}
                index="name"
                categories={[ranking.label]}
                layout="vertical"
                colorByDatum
                showLegend={false}
                yAxisWidth={180}
                valueFormatter={ranking.format}
                className="h-96"
              />
            </div>
            <DataTable
              data={bucket.rows}
              columns={breakdownColumns(bucket.nameTitle)}
              getRowId={(row) => row.name}
              isLoading={isLoading}
              defaultSorting={[{ id: "requests", desc: true }]}
              paginationMode="client"
              pageSizeOptions={[10, 25, 50]}
              size="compact"
              noDataMessage={bucket.empty}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
