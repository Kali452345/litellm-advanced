"use client";

import React from "react";

import { toast } from "@/lib/toast";
import { AddProviderKeyRequest, useAddProviderKey } from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import AddProviderKeyModal from "./AddProviderKeyModal";
import { describeRejections, summarizeAddedModels } from "./providerKeyPayload";
import type { AddKeyTarget } from "./providerKeyTarget";

interface AddProviderKeyDialogProps {
  target: AddKeyTarget | null;
  onClose: () => void;
}

const AddProviderKeyDialog: React.FC<AddProviderKeyDialogProps> = ({ target, onClose }) => {
  const addKey = useAddProviderKey();

  const handleSubmit = (body: AddProviderKeyRequest) => {
    addKey.mutate(body, {
      onSuccess: (response) => {
        const outcome = summarizeAddedModels(response);
        if (outcome.kind === "none-created") {
          toast.error(`No models added to ${body.provider}`, { description: describeRejections(outcome.rejected) });
          return;
        }
        if (outcome.kind === "partly-rejected") {
          toast.warning(`Key added to ${outcome.created} of ${body.provider}'s models`, {
            description: describeRejections(outcome.rejected),
          });
        } else {
          toast.success(`Key added to ${outcome.created} ${body.provider} model${outcome.created === 1 ? "" : "s"}`);
        }
        onClose();
      },
      onError: (error) => toast.fromError(error),
    });
  };

  return (
    <AddProviderKeyModal
      profile={target?.profile ?? null}
      focusModel={target?.focusModel ?? null}
      isSaving={addKey.isPending}
      onCancel={onClose}
      onSubmit={handleSubmit}
    />
  );
};

export default AddProviderKeyDialog;
