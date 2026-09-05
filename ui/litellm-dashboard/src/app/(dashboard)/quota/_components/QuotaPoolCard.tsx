"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { ObservedKeyView } from "@/app/(dashboard)/hooks/observedRateLimits/observedLimits";
import type { KeyView, PoolView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";

import { QuotaKeyRow } from "./QuotaKeyRow";

interface QuotaPoolCardProps {
  pool: PoolView;
  observedFor: (keyView: KeyView) => ObservedKeyView | null;
}

export function QuotaPoolCard({ pool, observedFor }: QuotaPoolCardProps) {
  return (
    <Card data-testid={`quota-pool-${pool.modelName}`}>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <CardTitle className="truncate text-base font-medium">{pool.modelName}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {pool.availableKeyCount} of {pool.keyCount} {pool.keyCount === 1 ? "key" : "keys"} has room right now
          </p>
        </div>
        {pool.exhausted ? (
          <Badge variant="destructive">
            {pool.readyIn ? `Every key spent, free in ${pool.readyIn}` : "Every key spent"}
          </Badge>
        ) : (
          <Badge variant="secondary">Serving</Badge>
        )}
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {pool.keys.map((keyView) => (
          <QuotaKeyRow key={keyView.modelId} keyView={keyView} observed={observedFor(keyView)} />
        ))}
      </CardContent>
    </Card>
  );
}
