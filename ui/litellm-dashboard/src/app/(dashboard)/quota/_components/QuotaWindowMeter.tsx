"use client";

import { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@/components/shared/Meter";

import type { WindowView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";

const WARNING_AT = 0.8;

const toneFor = (window: WindowView) => {
  if (window.spent) return "over" as const;
  return window.fractionUsed >= WARNING_AT ? ("warning" as const) : ("default" as const);
};

interface QuotaWindowMeterProps {
  window: WindowView;
}

export function QuotaWindowMeter({ window }: QuotaWindowMeterProps) {
  return (
    <Meter value={window.used} max={Math.max(window.limit, window.used)} data-testid={`quota-window-${window.kind}`}>
      <div className="flex items-baseline justify-between gap-2">
        <MeterLabel>{window.label}</MeterLabel>
        <div className="flex items-baseline gap-2">
          <MeterValue>
            {() => (
              <>
                {window.used} / {window.limit}
              </>
            )}
          </MeterValue>
          <span className="text-xs text-muted-foreground">
            {window.spent ? `free in ${window.resetsIn}` : `resets in ${window.resetsIn}`}
          </span>
        </div>
      </div>
      <MeterTrack>
        <MeterIndicator tone={toneFor(window)} />
      </MeterTrack>
    </Meter>
  );
}
