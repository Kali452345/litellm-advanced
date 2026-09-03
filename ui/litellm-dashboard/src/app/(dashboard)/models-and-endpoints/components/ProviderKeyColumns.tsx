"use client";

import { ColumnDef } from "@tanstack/react-table";
import { KeyRound } from "lucide-react";

import { DataTableSortHeader } from "@/components/shared/DataTable";
import { CellTooltip } from "@/components/shared/table_cells";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  ProviderProfile,
  ProviderProfileModel,
} from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import { capsLabel, profileCapsSummary } from "./providerKeyPayload";
import { quotaScopeLabel } from "@/lib/quotaScope";

const MAX_VISIBLE_MODELS = 3;

const modelBadge = (model: ProviderProfileModel) => (
  <CellTooltip
    key={model.model_name}
    content={`${model.litellm_model} - ${capsLabel(model.rpm, model.rpd)} per key`}
    trigger={
      <Badge variant="outline" className="cursor-default font-mono text-xs">
        {model.model_name}
      </Badge>
    }
  />
);

function ProviderModelsCell({ models }: { models: readonly ProviderProfileModel[] }) {
  const visible = models.slice(0, MAX_VISIBLE_MODELS);
  const overflow = models.slice(MAX_VISIBLE_MODELS);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map(modelBadge)}
      {overflow.length > 0 && (
        <CellTooltip
          content={
            <div className="flex max-w-[280px] flex-col gap-0.5">
              {overflow.map((model) => (
                <span key={model.model_name}>
                  {model.model_name} - {capsLabel(model.rpm, model.rpd)}
                </span>
              ))}
            </div>
          }
          trigger={
            <Badge variant="outline" className="cursor-default">
              +{overflow.length} more
            </Badge>
          }
        />
      )}
    </div>
  );
}

/**
 * Caps agree across every model of a provider often enough to be worth stating once. Where
 * they differ the column says so instead of picking one model's numbers to stand for all.
 */
interface ProviderKeyColumnsDeps {
  canWrite: boolean;
  onAddKey: (profile: ProviderProfile) => void;
}

export const getProviderKeyColumns = ({ canWrite, onAddKey }: ProviderKeyColumnsDeps): ColumnDef<ProviderProfile>[] => [
  {
    id: "provider",
    accessorKey: "provider",
    meta: { title: "Provider" },
    header: ({ column }) => <DataTableSortHeader column={column} title="Provider" />,
    size: 160,
    enableSorting: true,
    cell: ({ row }) => <span className="font-medium">{row.original.provider}</span>,
  },
  {
    id: "key_count",
    accessorKey: "key_count",
    meta: { title: "Keys", numeric: true },
    header: ({ column }) => <DataTableSortHeader column={column} title="Keys" />,
    size: 90,
    enableSorting: true,
    cell: ({ row }) => row.original.key_count,
  },
  {
    id: "models",
    meta: { title: "Models", skeleton: "chips" },
    header: "Models",
    size: 280,
    enableSorting: false,
    cell: ({ row }) => <ProviderModelsCell models={row.original.models} />,
  },
  {
    id: "caps",
    meta: { title: "Cap Per Key" },
    header: "Cap Per Key",
    size: 150,
    enableSorting: false,
    cell: ({ row }) => <span className="text-sm text-muted-foreground">{profileCapsSummary(row.original.models)}</span>,
  },
  {
    id: "quota_scope",
    meta: { title: "Cap Counted" },
    header: "Cap Counted",
    size: 150,
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">{quotaScopeLabel(row.original.quota_scope)}</span>
    ),
  },
  {
    id: "api_base",
    meta: { title: "Base URL" },
    header: "Base URL",
    size: 220,
    enableSorting: false,
    cell: ({ row }) =>
      row.original.api_base ? (
        <span className="block max-w-52 truncate font-mono text-xs" title={row.original.api_base}>
          {row.original.api_base}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">Provider default</span>
      ),
  },
  {
    id: "actions",
    meta: { className: "text-right", headerClassName: "text-right" },
    header: () => <span className="sr-only">Actions</span>,
    size: 120,
    enableSorting: false,
    enableHiding: false,
    cell: ({ row }) => (
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={!canWrite}
          title={canWrite ? undefined : "Only a proxy admin can add a key"}
          data-testid={`add-provider-key-${row.original.provider}`}
          onClick={() => onAddKey(row.original)}
        >
          <KeyRound />
          Add key
        </Button>
      </div>
    ),
  },
];
