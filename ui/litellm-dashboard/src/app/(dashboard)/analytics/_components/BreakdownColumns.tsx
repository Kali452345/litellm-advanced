"use client";

import type { ColumnDef } from "@tanstack/react-table";

import { DataTableSortHeader } from "@/components/shared/DataTable";

import type { BreakdownRow } from "@/app/(dashboard)/_lib/analyticsSummary";
import { formatAverage, formatCount, formatPercent, formatUsd } from "@/app/(dashboard)/_lib/format";

const numeric = (
  id: keyof BreakdownRow,
  title: string,
  render: (row: BreakdownRow) => string,
): ColumnDef<BreakdownRow, unknown> => ({
  accessorKey: id,
  header: ({ column }) => <DataTableSortHeader column={column} title={title} />,
  cell: ({ row }) => <span className="tabular-nums">{render(row.original)}</span>,
  meta: { numeric: true },
});

export const breakdownColumns = (nameTitle: string): ColumnDef<BreakdownRow, unknown>[] => [
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableSortHeader column={column} title={nameTitle} />,
    cell: ({ row }) => <span className="font-medium text-foreground">{row.original.name}</span>,
    meta: { pinned: "left" },
  },
  numeric("requests", "Requests", (row) => formatCount(row.requests)),
  numeric("failed", "Failed", (row) => formatCount(row.failed)),
  numeric("failureRate", "Failure rate", (row) => formatPercent(row.failureRate)),
  numeric("totalTokens", "Tokens", (row) => formatCount(row.totalTokens)),
  numeric("promptTokens", "Prompt", (row) => formatCount(row.promptTokens)),
  numeric("completionTokens", "Completion", (row) => formatCount(row.completionTokens)),
  numeric("tokensPerRequest", "Tokens / req", (row) => formatAverage(row.tokensPerRequest)),
  numeric("spend", "Spend", (row) => formatUsd(row.spend)),
];
