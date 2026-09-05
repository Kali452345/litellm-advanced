import { describe, expect, it } from "vitest";

import { DEFAULT_QUOTA_SCOPE, QUOTA_SCOPE_CHOICES, quotaScopeLabel } from "./quotaScope";

describe("quotaScopeLabel", () => {
  it("distinguishes a cap counted per model from one the whole key shares", () => {
    expect(quotaScopeLabel("credential")).toBe("Shared across models");
    expect(quotaScopeLabel("credential_model")).toBe("Per model");
  });

  it("reads an unset scope as the per-model default the router applies", () => {
    expect(quotaScopeLabel(null)).toBe("Per model");
    expect(quotaScopeLabel(undefined)).toBe("Per model");
  });
});

describe("QUOTA_SCOPE_CHOICES", () => {
  it("offers both ways a provider meters a key", () => {
    expect(QUOTA_SCOPE_CHOICES.map((choice) => choice.value)).toEqual(["credential_model", "credential"]);
  });

  it("leads with the default, so a form that prefills the first option meters what it does today", () => {
    expect(QUOTA_SCOPE_CHOICES[0].value).toBe(DEFAULT_QUOTA_SCOPE);
  });

  it("names each choice the way the provider keys table names it, so the two cannot drift apart", () => {
    expect(QUOTA_SCOPE_CHOICES.map((choice) => choice.label)).toEqual(
      QUOTA_SCOPE_CHOICES.map((choice) => quotaScopeLabel(choice.value)),
    );
  });
});
