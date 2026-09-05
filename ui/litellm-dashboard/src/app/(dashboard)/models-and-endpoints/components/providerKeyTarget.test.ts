import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import { resolveAddKeyAction } from "./providerKeyTarget";

const gemini: ProviderProfile = {
  provider: "gemini",
  api_base: null,
  api_version: null,
  key_count: 2,
  quota_scope: null,
  quota_reset_timezone: null,
  models: [
    { model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", rpm: 5, rpd: 100 },
    { model_name: "pro", litellm_model: "gemini/gemini-2.5-pro", rpm: 2, rpd: null },
  ],
};

const gateway: ProviderProfile = {
  provider: "openai",
  api_base: "https://gateway.example.com",
  api_version: null,
  key_count: 1,
  quota_scope: null,
  quota_reset_timezone: null,
  models: [{ model_name: "chat", litellm_model: "openai/gpt-5", rpm: null, rpd: null }],
};

const ready = { canWrite: true, isLoading: false, profiles: [gemini, gateway] };

describe("resolveAddKeyAction", () => {
  it("hands back the profile and the clicked model so only that model is preselected", () => {
    const action = resolveAddKeyAction(ready, {
      model_name: "pro",
      litellm_model_name: "gemini/gemini-2.5-pro",
      api_base: undefined,
    });

    expect(action).toEqual({
      kind: "ready",
      target: { profile: gemini, focusModel: "pro" },
      tooltip: "Add another gemini key behind pro",
    });
  });

  it("matches a deployment reached at its own base url to the profile at that url", () => {
    const action = resolveAddKeyAction(ready, {
      model_name: "chat",
      litellm_model_name: "openai/gpt-5",
      api_base: "https://gateway.example.com",
    });

    expect(action).toEqual({
      kind: "ready",
      target: { profile: gateway, focusModel: "chat" },
      tooltip: "Add another openai key behind chat",
    });
  });

  it("refuses a deployment whose base url no profile is reached at", () => {
    const action = resolveAddKeyAction(ready, {
      model_name: "chat",
      litellm_model_name: "openai/gpt-5",
      api_base: "https://elsewhere.example.com",
    });

    expect(action.kind).toBe("unavailable");
  });

  it("refuses a public model name the profile serves through a different provider model", () => {
    const action = resolveAddKeyAction(ready, {
      model_name: "pro",
      litellm_model_name: "vertex_ai/gemini-2.5-pro",
      api_base: undefined,
    });

    expect(action.kind).toBe("unavailable");
  });

  it("treats a null base url and an absent one as the same url", () => {
    const action = resolveAddKeyAction(
      { ...ready, profiles: [{ ...gemini, api_base: undefined }] },
      { model_name: "flash", litellm_model_name: "gemini/gemini-2.5-flash", api_base: undefined },
    );

    expect(action.kind).toBe("ready");
  });

  it("says a non-admin cannot add a key rather than offering a form that would 403", () => {
    const action = resolveAddKeyAction(
      { ...ready, canWrite: false },
      { model_name: "flash", litellm_model_name: "gemini/gemini-2.5-flash" },
    );

    expect(action).toEqual({ kind: "unavailable", tooltip: "Only a proxy admin can add a key" });
  });

  it("says it is still reading the provider rather than claiming no profile covers the model", () => {
    const action = resolveAddKeyAction(
      { canWrite: true, isLoading: true, profiles: undefined },
      { model_name: "flash", litellm_model_name: "gemini/gemini-2.5-flash" },
    );

    expect(action).toEqual({
      kind: "unavailable",
      tooltip: "Reading what this provider is already set up with",
    });
  });

  it("points a deployment no profile covers at Add Model instead", () => {
    const action = resolveAddKeyAction(
      { canWrite: true, isLoading: false, profiles: [] },
      { model_name: "flash", litellm_model_name: "gemini/gemini-2.5-flash" },
    );

    expect(action).toEqual({
      kind: "unavailable",
      tooltip: "No provider profile covers this deployment, so another key has to go through Add Model",
    });
  });
});
