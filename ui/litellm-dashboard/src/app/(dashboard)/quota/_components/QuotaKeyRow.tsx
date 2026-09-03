"use client";

import { Badge } from "@/components/ui/badge";

import type { KeyView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";

import { QuotaWindowMeter } from "./QuotaWindowMeter";

interface QuotaKeyRowProps {
  keyView: KeyView;
}

export function QuotaKeyRow({ keyView }: QuotaKeyRowProps) {
  return (
    <div className="rounded-lg border p-4" data-testid={`quota-key-${keyView.modelId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{keyView.litellmModel}</p>
          <p className="truncate text-xs text-muted-foreground">{keyView.apiBase ?? keyView.provider}</p>
        </div>
        {keyView.exhausted ? (
          <Badge variant="destructive">{keyView.readyIn ? `Spent, free in ${keyView.readyIn}` : "Spent"}</Badge>
        ) : (
          <Badge variant="secondary">Available</Badge>
        )}
      </div>

      {keyView.metered ? (
        <div className="mt-4 flex flex-col gap-3">
          {keyView.windows.map((window) => (
            <QuotaWindowMeter key={window.kind} window={window} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          No per-minute or per-day cap set, so this key is used without a quota check.
        </p>
      )}
    </div>
  );
}
