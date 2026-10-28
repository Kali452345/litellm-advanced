"use client";

import type { CapVerdict, ObservedKeyView } from "@/app/(dashboard)/hooks/observedRateLimits/observedLimits";
import { Badge } from "@/components/ui/badge";

const TONE: Record<CapVerdict, "destructive" | "secondary" | "outline"> = {
  too_high: "destructive",
  nothing_fits: "destructive",
  matches: "secondary",
  room_to_spare: "outline",
};

interface ObservedLimitsNoteProps {
  observed: ObservedKeyView;
}

export function ObservedLimitsNote({ observed }: ObservedLimitsNoteProps) {
  return (
    <div className="mt-4 border-t pt-3" data-testid={`observed-limits-${observed.modelId}`}>
      <p className="text-xs font-medium text-foreground">
        What the provider actually allowed
        <span className="ml-2 font-normal text-muted-foreground">
          {observed.refusals} {observed.refusals === 1 ? "refusal" : "refusals"}, last {observed.lastRefusal}
          {observed.longestWait ? `, longest wait asked for ${observed.longestWait}` : ""}
        </span>
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {observed.windows.map((window) => (
          <li key={window.kind} className="flex flex-wrap items-center gap-2" data-testid={`observed-${window.kind}`}>
            <Badge variant={TONE[window.verdict]}>{window.label}</Badge>
            <span className="text-xs text-muted-foreground">{window.headline}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
