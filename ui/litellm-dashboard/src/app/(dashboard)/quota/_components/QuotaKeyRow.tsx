"use client";

import React, { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { ObservedKeyView } from "@/app/(dashboard)/hooks/observedRateLimits/observedLimits";
import type { KeyView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";
import { useToggleKeyPaused } from "@/app/(dashboard)/hooks/quotaUsage/useQuotaKeyActions";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { isProxyAdminRole } from "@/utils/roles";

import KeyModelDialog from "./KeyModelDialog";
import { ObservedLimitsNote } from "./ObservedLimitsNote";
import { QuotaWindowMeter } from "./QuotaWindowMeter";

interface QuotaKeyRowProps {
  keyView: KeyView;
  observed: ObservedKeyView | null;
}

function KeyStatusBadge({ keyView }: { keyView: KeyView }) {
  if (keyView.blocked) return <Badge variant="outline">Paused</Badge>;
  if (keyView.exhausted) {
    return <Badge variant="destructive">{keyView.readyIn ? `Spent, free in ${keyView.readyIn}` : "Spent"}</Badge>;
  }
  return <Badge variant="secondary">Available</Badge>;
}

function KeyFailureNote({ keyView }: { keyView: KeyView }) {
  if (keyView.recentFailures <= 0) return null;
  return (
    <p className="mt-3 text-xs text-muted-foreground" title={keyView.lastError ?? undefined}>
      {keyView.recentFailures} {keyView.recentFailures === 1 ? "failure" : "failures"} in the last day
      {keyView.lastError ? `: ${keyView.lastError}` : ""}
    </p>
  );
}

export function QuotaKeyRow({ keyView, observed }: QuotaKeyRowProps) {
  const { userRole } = useAuthorized();
  const canWrite = isProxyAdminRole(userRole ?? "");
  const togglePaused = useToggleKeyPaused();
  const [servingAnother, setServingAnother] = useState(false);

  return (
    <div className="rounded-lg border p-4" data-testid={`quota-key-${keyView.modelId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{keyView.litellmModel}</p>
          <p className="truncate text-xs text-muted-foreground">{keyView.apiBase ?? keyView.provider}</p>
        </div>
        <KeyStatusBadge keyView={keyView} />
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

      {observed && <ObservedLimitsNote observed={observed} />}
      <KeyFailureNote keyView={keyView} />

      {canWrite && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={togglePaused.isPending}
            onClick={() => togglePaused.mutate({ modelId: keyView.modelId, blocked: !keyView.blocked })}
          >
            {keyView.blocked ? "Resume" : "Pause"}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setServingAnother(true)}>
            Serve another model
          </Button>
        </div>
      )}

      {servingAnother && <KeyModelDialog keyView={keyView} onClose={() => setServingAnother(false)} />}
    </div>
  );
}
