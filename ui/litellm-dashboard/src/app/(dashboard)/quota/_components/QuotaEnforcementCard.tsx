"use client";

import { useId, useState } from "react";

import { useUpdateQuotaSettings } from "@/app/(dashboard)/hooks/quotaUsage/useUpdateQuotaSettings";
import {
  holdText,
  quotaSettingsState,
  type QuotaSettingsDraft,
  type QuotaSettingsLive,
} from "@/app/(dashboard)/quota/_lib/quotaSettingsForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";

export function QuotaEnforcementCard({ live }: { live: QuotaSettingsLive }) {
  const enforceId = useId();
  const holdId = useId();
  const save = useUpdateQuotaSettings();
  const [draft, setDraft] = useState<QuotaSettingsDraft | null>(null);

  const shown = draft ?? { enforced: live.enforced, holdSeconds: holdText(live.maxWaitSeconds) };
  const state = quotaSettingsState(shown, live);
  const invalid = state.kind === "invalid";

  const toggle = (enforced: boolean) =>
    setDraft({ enforced, holdSeconds: enforced ? shown.holdSeconds : holdText(live.maxWaitSeconds) });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (state.kind !== "ready") return;

    save.mutate(state.update, {
      onSuccess: () => {
        setDraft(null);
        toast.success(
          state.update.enable_quota_routing
            ? `Quota routing on, holding a spent request up to ${state.update.quota_max_wait_seconds}s`
            : "Quota routing off, every key is used without a quota check",
        );
      },
      onError: (error) => toast.fromError(error),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">Rotation settings</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={enforceId}>Enforce per-key quotas</FieldLabel>
              <FieldDescription>
                Count every request against the per-minute and per-day caps set on each key, and route around a key that
                has spent its allowance instead of letting the request fail.
              </FieldDescription>
            </FieldContent>
            <Switch
              id={enforceId}
              checked={shown.enforced}
              onCheckedChange={toggle}
              disabled={live.maxWaitSeconds == null}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={holdId}>Hold budget (seconds)</FieldLabel>
            <Input
              id={holdId}
              className="max-w-32"
              inputMode="decimal"
              value={shown.holdSeconds}
              aria-invalid={invalid}
              disabled={!shown.enforced || live.maxWaitSeconds == null}
              onChange={(event) => setDraft({ enforced: shown.enforced, holdSeconds: event.target.value })}
            />
            <FieldDescription>
              {shown.enforced
                ? "How long a request waits when every key behind the model it asked for is spent, so a minute window about to roll over is a slower answer rather than a failure. 0 never holds."
                : "Only used while enforcement is on. Turn it on to set how long a spent request waits."}
            </FieldDescription>
            <FieldError>{invalid ? state.message : null}</FieldError>
          </Field>

          <div className="flex justify-end">
            <Button type="submit" disabled={state.kind !== "ready" || save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
