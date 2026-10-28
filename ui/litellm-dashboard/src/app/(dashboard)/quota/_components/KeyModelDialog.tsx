"use client";

import React from "react";
import { z } from "zod/v4";

import type { KeyView } from "@/app/(dashboard)/hooks/quotaUsage/quotaSummary";
import { useAddKeyModel } from "@/app/(dashboard)/hooks/quotaUsage/useQuotaKeyActions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { FormField } from "@/components/shared/form/FormField";
import { Input } from "@/components/ui/input";
import { useZodForm } from "@/lib/forms/useZodForm";

import { planKeyModel } from "./keyModelPayload";

const keyModelSchema = z.object({
  modelName: z.string().trim().min(1, "Name the public model callers ask for"),
  litellmModel: z.string().trim().min(1, "Name the model string the provider itself is sent"),
});

interface KeyModelDialogProps {
  keyView: KeyView | null;
  onClose: () => void;
}

const KeyModelDialog: React.FC<KeyModelDialogProps> = ({ keyView, onClose }) => {
  const addModel = useAddKeyModel();
  const form = useZodForm(keyModelSchema, { values: { modelName: "", litellmModel: "" } });
  const submit = form.handleSubmit((values) => {
    if (!keyView) return;
    const plan = planKeyModel(keyView.modelId, values);
    if (plan.kind === "blocked") {
      form.setError(plan.field, { message: plan.message });
      return;
    }
    addModel.mutate(plan.request, {
      onSuccess: (added) => {
        if (added?.model_id) onClose();
      },
    });
  });

  return (
    <Dialog open={keyView !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Serve another model with this key</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The caps, base url, and metering stay exactly as {keyView?.litellmModel} has them. The key itself never
          leaves the server.
        </p>
        <form onSubmit={submit} noValidate>
          <FieldGroup className="mt-4">
            <FormField control={form.control} name="modelName" label="Public model name">
              {({ ref, value, ...field }) => (
                <Input {...field} ref={ref} value={value ?? ""} placeholder="smart" autoComplete="off" />
              )}
            </FormField>
            <FormField
              control={form.control}
              name="litellmModel"
              label="Provider model"
              description="The model string the provider itself is sent."
            >
              {({ ref, value, ...field }) => (
                <Input {...field} ref={ref} value={value ?? ""} placeholder="openai/gpt-5" autoComplete="off" />
              )}
            </FormField>
          </FieldGroup>
          <div className="mt-6 flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={addModel.isPending}>
              {addModel.isPending ? "Adding..." : "Add Model"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default KeyModelDialog;
