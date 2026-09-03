import type {
  AddProviderKeyRequest,
  AddProviderKeyResponse,
  ProviderProfile,
  ProviderProfileModel,
} from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";

export interface ProviderKeyFormValues {
  api_key: string;
  api_base?: string;
  rpm?: string;
  rpd?: string;
  models?: string[];
}

export const providerKeyFormValues = (
  profile: ProviderProfile | null,
  focusModel?: string | null,
): Required<ProviderKeyFormValues> => {
  const served = (profile?.models ?? []).map((model) => model.model_name);

  return {
    api_key: "",
    api_base: profile?.api_base ?? "",
    rpm: "",
    rpd: "",
    models: focusModel && served.includes(focusModel) ? [focusModel] : served,
  };
};

const servesEveryModel = (selected: readonly string[], profile: ProviderProfile): boolean =>
  profile.models.every((model) => selected.includes(model.model_name));

/**
 * The base url is always sent, since the api reads an absent one as "copy the provider's" and a
 * null one as "the provider's own default", which is the only way to name that url for a provider
 * reached at both. `models` is left out when every model is picked, so the new key still serves a
 * model added to the provider after this page loaded.
 */
export const buildAddProviderKeyBody = (
  profile: ProviderProfile,
  values: ProviderKeyFormValues,
): AddProviderKeyRequest => {
  const apiBase = values.api_base?.trim() ?? "";
  const selected = values.models ?? [];

  return {
    provider: profile.provider,
    api_key: values.api_key.trim(),
    api_base: apiBase === "" ? null : apiBase,
    ...(values.rpm ? { rpm: Number(values.rpm) } : {}),
    ...(values.rpd ? { rpd: Number(values.rpd) } : {}),
    ...(servesEveryModel(selected, profile) ? {} : { models: [...selected] }),
  };
};

export interface RejectedModel {
  model_name: string;
  error: string;
}

export type AddProviderKeyOutcome =
  | { kind: "all-created"; created: number }
  | { kind: "partly-rejected"; created: number; rejected: readonly RejectedModel[] }
  | { kind: "none-created"; rejected: readonly RejectedModel[] };

export const summarizeAddedModels = (response: AddProviderKeyResponse | undefined): AddProviderKeyOutcome => {
  const models = response?.models ?? [];
  const rejected: readonly RejectedModel[] = models
    .filter((model) => model.error)
    .map((model) => ({ model_name: model.model_name, error: model.error ?? "" }));
  const created = models.length - rejected.length;

  if (rejected.length === 0) return { kind: "all-created", created };
  if (created === 0) return { kind: "none-created", rejected };
  return { kind: "partly-rejected", created, rejected };
};

export const describeRejections = (rejected: readonly RejectedModel[]): string =>
  rejected.map((model) => `${model.model_name}: ${model.error}`).join("; ");

export const capsLabel = (rpm: number | null | undefined, rpd: number | null | undefined): string => {
  const parts = [rpm == null ? null : `${rpm}/min`, rpd == null ? null : `${rpd}/day`].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(", ") : "No cap";
};

/**
 * Caps agree across every model of a provider often enough to be worth stating once. Where they
 * differ the summary says so rather than picking one model's numbers to stand for all of them.
 */
export const profileCapsSummary = (models: readonly ProviderProfileModel[]): string => {
  if (models.length === 0) return "No models";
  const labels = new Set(models.map((model) => capsLabel(model.rpm, model.rpd)));
  return labels.size === 1 ? [...labels][0] : "Varies by model";
};

export const quotaScopeLabel = (quotaScope: ProviderProfile["quota_scope"]): string =>
  quotaScope === "credential" ? "Shared across models" : "Per model";
