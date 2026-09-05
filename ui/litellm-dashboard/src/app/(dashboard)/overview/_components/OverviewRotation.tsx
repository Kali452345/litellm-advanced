"use client";

import { Meter, MeterIndicator, MeterTrack } from "@/components/shared/Meter";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MIGRATED_PAGES, migratedHref } from "@/utils/migratedPages";

import { formatPercent } from "@/app/(dashboard)/_lib/format";

import type { RotationRow } from "../_lib/overviewSummary";

const WARNING_AT = 0.8;

interface OverviewRotationProps {
  rows: readonly RotationRow[];
}

function StatusBadge({ row }: { row: RotationRow }) {
  if (row.status === "spent") {
    return <Badge variant="destructive">{row.readyIn ? `Free in ${row.readyIn}` : "Every key spent"}</Badge>;
  }
  if (row.status === "single-key") return <Badge variant="outline">Single key</Badge>;
  return <Badge variant="secondary">Serving</Badge>;
}

function PoolRow({ row }: { row: RotationRow }) {
  return (
    <TableRow data-testid={`overview-pool-${row.modelName}`}>
      <TableCell className="font-medium text-foreground">{row.modelName}</TableCell>
      <TableCell className="tabular-nums">
        {row.availableKeyCount} of {row.keyCount}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Meter value={row.fractionUsed * 100} max={100} aria-label={`${row.modelName} keys drained`} className="w-24">
            <MeterTrack>
              <MeterIndicator tone={row.fractionUsed >= WARNING_AT ? "warning" : "default"} />
            </MeterTrack>
          </Meter>
          <span className="text-xs tabular-nums text-muted-foreground">{formatPercent(row.fractionUsed)}</span>
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge row={row} />
      </TableCell>
    </TableRow>
  );
}

export function OverviewRotation({ rows }: OverviewRotationProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base font-medium">Key rotation</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            How much of each pool the router has spent, and what it can still send to
          </p>
        </div>
        <a
          href={migratedHref(MIGRATED_PAGES.quota)}
          className="shrink-0 text-sm font-medium text-info underline-offset-4 hover:underline"
        >
          Every key
        </a>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No model is set up yet. Add one under Models &amp; Keys and every key behind it shows up here.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Keys with room</TableHead>
                <TableHead>Quota used</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <PoolRow key={row.modelName} row={row} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
