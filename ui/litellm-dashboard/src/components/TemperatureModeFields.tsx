"use client";

import * as React from "react";
import type { Control } from "react-hook-form";

import { Display, FieldLabel, Hint } from "@/components/shared/form/FieldDisplay";
import { FormField } from "@/components/shared/form/FormField";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  DEFAULT_TEMPERATURE_MODE,
  PINNED_TEMPERATURE_FIELD,
  TEMPERATURE_MODE_CHOICES,
  TEMPERATURE_MODE_FIELD,
  temperatureModeSummary,
  type TemperatureMode,
  type TemperatureOverrideParams,
} from "@/lib/temperatureMode";

import type { ModelEditFormValues } from "./ModelInfoEditForm";

export const TEMPERATURE_MODE_LABEL = "Temperature The Provider Receives";

export const TEMPERATURE_MODE_HINT =
  "A deployment's own params are only defaults the request overrides, so an agent that hardcodes a temperature " +
  "its provider rejects fails every call. Taking the param out or answering with your own value fixes that " +
  "without touching the agent.";

export const PINNED_TEMPERATURE_LABEL = "Temperature To Send Instead";

export const PINNED_TEMPERATURE_HINT =
  "Replaces whatever the caller sent. Most providers take 0 through 2, and a provider that only allows 1 " +
  "needs exactly 1 here.";

export const TemperatureModeRadios: React.FC<{
  value: TemperatureMode;
  onChange: (mode: TemperatureMode) => void;
}> = ({ value, onChange }) => (
  <RadioGroup value={value} onValueChange={(picked) => onChange(picked as TemperatureMode)}>
    {TEMPERATURE_MODE_CHOICES.map((choice) => (
      <Label key={choice.value} className="items-start font-normal leading-normal">
        <RadioGroupItem value={choice.value} className="mt-0.5" />
        <span>
          <strong className="font-semibold">{choice.label}</strong>{" "}
          <span className="text-muted-foreground">{choice.description}</span>
        </span>
      </Label>
    ))}
  </RadioGroup>
);

export const TemperatureModeFields: React.FC<{
  control: Control<ModelEditFormValues>;
  mode: TemperatureMode;
  isEditing: boolean;
  stored: TemperatureOverrideParams | null | undefined;
}> = ({ control, mode, isEditing, stored }) => {
  if (!isEditing) {
    return (
      <div>
        <FieldLabel>
          {TEMPERATURE_MODE_LABEL}
          <Hint text={TEMPERATURE_MODE_HINT} />
        </FieldLabel>
        <Display>{temperatureModeSummary(stored)}</Display>
      </div>
    );
  }

  return (
    <>
      <FormField
        control={control}
        name={TEMPERATURE_MODE_FIELD}
        label={
          <>
            {TEMPERATURE_MODE_LABEL}
            <Hint text={TEMPERATURE_MODE_HINT} />
          </>
        }
      >
        {({ value, onChange }) => (
          <TemperatureModeRadios
            value={(value as TemperatureMode | undefined) ?? DEFAULT_TEMPERATURE_MODE}
            onChange={onChange}
          />
        )}
      </FormField>
      {mode === "pin" && (
        <FormField
          control={control}
          name={PINNED_TEMPERATURE_FIELD}
          label={PINNED_TEMPERATURE_LABEL}
          description={PINNED_TEMPERATURE_HINT}
        >
          {({ value, ...field }) => <Input {...field} value={(value as string) ?? ""} placeholder="e.g. 0.3" />}
        </FormField>
      )}
    </>
  );
};
