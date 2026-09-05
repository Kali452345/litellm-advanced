"use client";

import React from "react";
import { z } from "zod/v4";

import { FieldGroup } from "@/components/ui/field";
import { FormField } from "@/components/shared/form/FormField";
import { MultiSelect } from "@/components/shared/MultiSelect";
import NumericalInput from "@/components/shared/numerical_input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useZodForm } from "@/lib/forms/useZodForm";
import { QUOTA_SCOPE_CHOICES, type QuotaScopeMode } from "@/lib/quotaScope";
import type {
  AddProviderKeyRequest,
  ProviderProfile,
} from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import { buildAddProviderKeyBody, capsLabel, providerKeyFormValues } from "./providerKeyPayload";
import RateLimitTester from "./RateLimitTester";
import { planRateLimitProbe } from "./rateLimitProbe";

const wholeRequests = z
  .string()
  .optional()
  .refine((value) => !value || /^\d+$/.test(value), { message: "Enter a whole number of requests" });

const providerKeySchema = z.object({
  api_key: z.string().trim().min(1, "Paste the key this provider issued"),
  api_base: z.string().optional(),
  rpm: wholeRequests,
  rpd: wholeRequests,
  models: z.array(z.string()).min(1, "Pick at least one model for this key to serve"),
  quota_scope: z.enum(["credential_model", "credential"]),
});

interface AddProviderKeyModalProps {
  profile: ProviderProfile | null;
  focusModel?: string | null;
  isSaving: boolean;
  onCancel: () => void;
  onSubmit: (body: AddProviderKeyRequest) => void;
}

const AddProviderKeyModal: React.FC<AddProviderKeyModalProps> = ({
  profile,
  focusModel,
  isSaving,
  onCancel,
  onSubmit,
}) => {
  const form = useZodForm(providerKeySchema, { values: providerKeyFormValues(profile, focusModel) });
  const modelOptions = (profile?.models ?? []).map((model) => ({
    value: model.model_name,
    label: model.model_name,
    description: `${model.litellm_model} - ${capsLabel(model.rpm, model.rpd)}`,
  }));
  const startedFromOneModel = Boolean(focusModel) && modelOptions.some((option) => option.value === focusModel);
  const submit = form.handleSubmit((values) => {
    if (!profile) return;
    onSubmit(buildAddProviderKeyBody(profile, values));
  });

  return (
    <Dialog open={profile !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {startedFromOneModel ? `Add another key behind ${focusModel}` : `Add another key to ${profile?.provider}`}
          </DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The key joins the {profile?.key_count} already behind {profile?.provider}, so requests rotate onto it and fail
          over to it.{" "}
          {startedFromOneModel
            ? `Only ${focusModel} is picked, so add the provider's other models if this key serves them too.`
            : "It serves the same models under the same caps."}{" "}
          Everything except the key itself is filled in from what this provider is already set up with.
        </p>
        <form onSubmit={submit} noValidate>
          <FieldGroup className="mt-4">
            <FormField
              control={form.control}
              name="api_key"
              label="API Key"
              description="The only field you have to fill in."
            >
              {({ ref, value, ...field }) => (
                <Input {...field} ref={ref} type="password" value={value ?? ""} autoComplete="off" />
              )}
            </FormField>

            <FormField
              control={form.control}
              name="models"
              label="Models this key serves"
              description={
                startedFromOneModel
                  ? "Only the model you came from is picked. Add the provider's others if this key serves them too."
                  : "Every model the provider serves is picked. Drop the ones this key's tier does not include."
              }
            >
              {({ id, value, onChange }) => (
                <MultiSelect
                  id={id}
                  options={modelOptions}
                  value={value ?? []}
                  onValueChange={onChange}
                  placeholder="Select models"
                />
              )}
            </FormField>

            <FormField
              control={form.control}
              name="rpm"
              label="Requests Per Minute"
              description="Leave blank to copy each model's per-minute cap from the keys already there."
            >
              {({ ref, value, ...field }) => (
                <NumericalInput
                  {...field}
                  ref={ref}
                  value={value ?? ""}
                  step={1}
                  min={0}
                  placeholder="Same as the others"
                />
              )}
            </FormField>

            <FormField
              control={form.control}
              name="rpd"
              label="Requests Per Day"
              description="Leave blank to copy each model's per-day cap from the keys already there."
            >
              {({ ref, value, ...field }) => (
                <NumericalInput
                  {...field}
                  ref={ref}
                  value={value ?? ""}
                  step={1}
                  min={0}
                  placeholder="Same as the others"
                />
              )}
            </FormField>

            <FormField
              control={form.control}
              name="quota_scope"
              label="How those caps are counted"
              description="A key that serves more than one model either gets the caps once per model or once for the whole key."
            >
              {({ value, onChange }) => (
                <RadioGroup value={value} onValueChange={(picked) => onChange(picked as QuotaScopeMode)}>
                  {QUOTA_SCOPE_CHOICES.map((choice) => (
                    <Label key={choice.value} className="items-start font-normal leading-normal">
                      <RadioGroupItem value={choice.value} className="mt-0.5" />
                      <span>
                        <strong className="font-semibold">{choice.label}</strong>{" "}
                        <span className="text-muted-foreground">{choice.description}</span>
                      </span>
                    </Label>
                  ))}
                </RadioGroup>
              )}
            </FormField>

            <RateLimitTester
              planProbe={() => planRateLimitProbe(profile, form.getValues())}
              onUseCap={(fill) => form.setValue(fill.field, String(fill.requests), { shouldValidate: true })}
            />

            <FormField
              control={form.control}
              name="api_base"
              label="Base URL"
              description="Keep it to reach this key where the others are, change it for a different url, or clear it for the provider's own default."
            >
              {({ ref, value, ...field }) => (
                <Input {...field} ref={ref} value={value ?? ""} placeholder="The provider's default" />
              )}
            </FormField>
          </FieldGroup>

          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Adding..." : "Add Key"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default AddProviderKeyModal;
