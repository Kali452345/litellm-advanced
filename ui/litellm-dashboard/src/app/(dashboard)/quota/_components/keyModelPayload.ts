import type { AddKeyModelRequest } from "@/app/(dashboard)/hooks/quotaUsage/useQuotaKeyActions";

export interface KeyModelFormValues {
  modelName: string;
  litellmModel: string;
}

export type KeyModelPlan =
  | { kind: "ready"; request: AddKeyModelRequest }
  | { kind: "blocked"; field: "modelName" | "litellmModel"; message: string };

/**
 * The credential never leaves the server: only the source deployment id and the
 * two names travel. Both names are required because the public name is what
 * callers ask for while the provider string is what the provider is sent.
 */
export const planKeyModel = (modelId: string, values: KeyModelFormValues): KeyModelPlan => {
  const modelName = values.modelName.trim();
  if (modelName === "") {
    return {
      kind: "blocked",
      field: "modelName",
      message: "The public name is what callers ask for, so the deployment has nothing to serve without it",
    };
  }
  const litellmModel = values.litellmModel.trim();
  if (litellmModel === "") {
    return {
      kind: "blocked",
      field: "litellmModel",
      message: "The provider string is what the provider itself is sent, so the key has nowhere to send without it",
    };
  }
  return { kind: "ready", request: { model_id: modelId, model_name: modelName, litellm_model: litellmModel } };
};
