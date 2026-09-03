import type { ProviderProfile } from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";

export interface DeploymentIdentity {
  model_name?: string;
  litellm_model_name?: string;
  api_base?: string;
}

export interface AddKeyTarget {
  profile: ProviderProfile;
  focusModel: string | null;
}

export type AddKeyAction =
  | { kind: "ready"; target: AddKeyTarget; tooltip: string }
  | { kind: "unavailable"; tooltip: string };

export interface AddKeyContext {
  canWrite: boolean;
  isLoading: boolean;
  profiles: readonly ProviderProfile[] | undefined;
}

const sameBase = (left: string | null | undefined, right: string | null | undefined): boolean =>
  (left ?? "") === (right ?? "");

/**
 * A deployment is matched on the model string the provider is sent plus the base url it is reached
 * at, never on the provider name the table shows, which is guessed from the model string and falls
 * back to openai. Two providers can serve one public model name at the same null base url, and only
 * the litellm model string tells them apart.
 */
export const resolveAddKeyAction = (context: AddKeyContext, model: DeploymentIdentity): AddKeyAction => {
  if (!context.canWrite) {
    return { kind: "unavailable", tooltip: "Only a proxy admin can add a key" };
  }
  if (context.isLoading) {
    return { kind: "unavailable", tooltip: "Reading what this provider is already set up with" };
  }

  const profile = (context.profiles ?? []).find(
    (candidate) =>
      sameBase(candidate.api_base, model.api_base) &&
      candidate.models.some(
        (served) => served.litellm_model === model.litellm_model_name && served.model_name === model.model_name,
      ),
  );

  if (!profile) {
    return {
      kind: "unavailable",
      tooltip: "No provider profile covers this deployment, so another key has to go through Add Model",
    };
  }

  return {
    kind: "ready",
    target: { profile, focusModel: model.model_name ?? null },
    tooltip: `Add another ${profile.provider} key behind ${model.model_name}`,
  };
};
