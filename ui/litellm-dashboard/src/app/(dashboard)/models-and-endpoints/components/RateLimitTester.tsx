"use client";

import React from "react";

import { useProbeRateLimit } from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { capFillLabel, type CapFill, type ProbeNote, type ProbePlan, readRateLimitProbe } from "./rateLimitProbe";

interface RateLimitTesterProps {
  planProbe: () => ProbePlan;
  onUseCap: (fill: CapFill) => void;
}

/**
 * The plan is read at click time rather than watched, so typing the key does not re-render the form
 * on every keystroke.
 */
const RateLimitTester: React.FC<RateLimitTesterProps> = ({ planProbe, onUseCap }) => {
  const probe = useProbeRateLimit();
  const [note, setNote] = React.useState<ProbeNote | null>(null);
  const fill = note?.fill ?? null;

  const run = () => {
    const plan = planProbe();
    if (plan.kind === "blocked") {
      setNote(plan.note);
      return;
    }
    setNote(null);
    probe.mutate(plan.request, {
      onSuccess: (response) => setNote(readRateLimitProbe(response)),
      onError: (error) => toast.fromError(error),
    });
  };

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="text-sm font-medium">Not sure what the cap on this key is?</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Send real requests to the first model above until the provider refuses one. The count it accepted is the cap,
        and it costs whatever those requests cost.
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-2" disabled={probe.isPending} onClick={run}>
        {probe.isPending ? "Testing..." : "Test the limit"}
      </Button>
      {note && (
        <div className="mt-3 border-t border-border pt-3" role="status">
          <p className="text-sm font-medium">{note.headline}</p>
          <p className="mt-1 text-sm text-muted-foreground">{note.detail}</p>
          {fill && (
            <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => onUseCap(fill)}>
              {capFillLabel(fill)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default RateLimitTester;
