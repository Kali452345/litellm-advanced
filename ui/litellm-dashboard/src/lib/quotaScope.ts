import type { components } from "@/lib/http/schema";

export type QuotaScopeMode = NonNullable<components["schemas"]["LiteLLM_Params"]["quota_scope"]>;

export const DEFAULT_QUOTA_SCOPE: QuotaScopeMode = "credential_model";

export interface QuotaScopeChoice {
  readonly value: QuotaScopeMode;
  readonly label: string;
  readonly description: string;
}

/**
 * One key serving several models is one deployment per model, so its caps are counted either once
 * per model or once for the whole key. Which of the two is right is a fact about the provider,
 * being a limit it publishes per model against an account it meters as a whole.
 */
const QUOTA_SCOPES: Readonly<Record<QuotaScopeMode, Omit<QuotaScopeChoice, "value">>> = {
  credential_model: {
    label: "Per model",
    description:
      "Each model this key serves counts the caps above on its own, which is what a provider that " +
      "publishes a limit per model gives you",
  },
  credential: {
    label: "Shared across models",
    description:
      "Every model this key serves counts into one allowance, which is what an account metered as a " +
      "whole has, so three models at 5 a minute is 5 a minute between them",
  },
};

export const QUOTA_SCOPE_CHOICES: readonly QuotaScopeChoice[] = (["credential_model", "credential"] as const).map(
  (value) => ({ value, ...QUOTA_SCOPES[value] }),
);

export const quotaScopeLabel = (scope: QuotaScopeMode | null | undefined): string =>
  QUOTA_SCOPES[scope ?? DEFAULT_QUOTA_SCOPE].label;
