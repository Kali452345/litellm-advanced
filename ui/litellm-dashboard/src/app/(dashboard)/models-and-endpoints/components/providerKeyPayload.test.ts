import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import {
  buildAddProviderKeyBody,
  capsLabel,
  describeRejections,
  profileCapsSummary,
  providerKeyFormValues,
  quotaScopeLabel,
  summarizeAddedModels,
} from "./providerKeyPayload";

const profile = (overrides: Partial<ProviderProfile> = {}): ProviderProfile => ({
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
  ...overrides,
});

describe("providerKeyFormValues", () => {
  it("starts with every model of the provider picked, so one key serves the whole pool", () => {
    expect(providerKeyFormValues(profile()).models).toEqual(["flash", "pro"]);
  });

  it("prefills the base url the provider is already reached at", () => {
    expect(providerKeyFormValues(profile({ api_base: "https://one.example.com" })).api_base).toBe(
      "https://one.example.com",
    );
  });

  it("never prefills a key or a cap", () => {
    const values = providerKeyFormValues(profile());

    expect([values.api_key, values.rpm, values.rpd]).toEqual(["", "", ""]);
  });
});

describe("buildAddProviderKeyBody", () => {
  it("sends only the provider and the trimmed key when nothing is overridden", () => {
    expect(buildAddProviderKeyBody(profile(), { api_key: "  k3  ", models: ["flash", "pro"] })).toEqual({
      provider: "gemini",
      api_key: "k3",
    });
  });

  it("sends caps as numbers, not the strings the inputs hold", () => {
    const body = buildAddProviderKeyBody(profile(), { api_key: "k3", rpm: "8", rpd: "250", models: ["flash", "pro"] });

    expect(body.rpm).toBe(8);
    expect(body.rpd).toBe(250);
  });

  it("leaves a blank cap out, so the provider's own cap is copied instead of overridden", () => {
    const body = buildAddProviderKeyBody(profile(), { api_key: "k3", rpm: "", rpd: "", models: ["flash", "pro"] });

    expect("rpm" in body).toBe(false);
    expect("rpd" in body).toBe(false);
  });

  it("names the models only when the key serves some of them, not all", () => {
    const subset = buildAddProviderKeyBody(profile(), { api_key: "k3", models: ["pro"] });
    const everything = buildAddProviderKeyBody(profile(), { api_key: "k3", models: ["flash", "pro"] });

    expect(subset.models).toEqual(["pro"]);
    expect("models" in everything).toBe(false);
  });

  it("sends the base url the row was opened from, so the right pool gets the key", () => {
    const body = buildAddProviderKeyBody(profile({ api_base: "https://two.example.com" }), {
      api_key: "k3",
      api_base: "https://two.example.com",
      models: ["flash", "pro"],
    });

    expect(body.api_base).toBe("https://two.example.com");
  });

  it("leaves a whitespace-only base url out rather than sending an empty string", () => {
    const body = buildAddProviderKeyBody(profile(), { api_key: "k3", api_base: "   ", models: ["flash", "pro"] });

    expect("api_base" in body).toBe(false);
  });
});

describe("summarizeAddedModels", () => {
  it("reports every model created", () => {
    expect(
      summarizeAddedModels({
        provider: "gemini",
        models: [
          { model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", model_id: "id-1" },
          { model_name: "pro", litellm_model: "gemini/gemini-2.5-pro", model_id: "id-2" },
        ],
      }),
    ).toEqual({ kind: "all-created", created: 2 });
  });

  it("keeps the models that landed when one is rejected", () => {
    expect(
      summarizeAddedModels({
        provider: "gemini",
        models: [
          { model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", error: "not on this key's tier" },
          { model_name: "pro", litellm_model: "gemini/gemini-2.5-pro", model_id: "id-2" },
        ],
      }),
    ).toEqual({
      kind: "partly-rejected",
      created: 1,
      rejected: [{ model_name: "flash", error: "not on this key's tier" }],
    });
  });

  it("separates a total failure from a partial one", () => {
    expect(
      summarizeAddedModels({
        provider: "gemini",
        models: [{ model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", error: "bad key" }],
      }),
    ).toEqual({ kind: "none-created", rejected: [{ model_name: "flash", error: "bad key" }] });
  });

  it("treats a missing response as nothing created", () => {
    expect(summarizeAddedModels(undefined)).toEqual({ kind: "all-created", created: 0 });
  });
});

describe("describeRejections", () => {
  it("names each model with why it was refused", () => {
    expect(
      describeRejections([
        { model_name: "flash", error: "not on this key's tier" },
        { model_name: "pro", error: "quota exhausted" },
      ]),
    ).toBe("flash: not on this key's tier; pro: quota exhausted");
  });
});

describe("capsLabel", () => {
  it("reads out both windows", () => {
    expect(capsLabel(5, 100)).toBe("5/min, 100/day");
  });

  it("says only the window that is capped", () => {
    expect(capsLabel(5, null)).toBe("5/min");
    expect(capsLabel(null, 100)).toBe("100/day");
  });

  it("says no cap rather than showing nothing", () => {
    expect(capsLabel(null, undefined)).toBe("No cap");
  });

  it("shows a zero cap instead of treating it as unset", () => {
    expect(capsLabel(0, 0)).toBe("0/min, 0/day");
  });
});

describe("profileCapsSummary", () => {
  it("states the cap once when every model shares it", () => {
    expect(
      profileCapsSummary([
        { model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", rpm: 5, rpd: 100 },
        { model_name: "pro", litellm_model: "gemini/gemini-2.5-pro", rpm: 5, rpd: 100 },
      ]),
    ).toBe("5/min, 100/day");
  });

  it("refuses to speak for the others when one model's cap differs", () => {
    expect(profileCapsSummary(profile().models)).toBe("Varies by model");
  });

  it("says there are no models rather than reading as an uncapped provider", () => {
    expect(profileCapsSummary([])).toBe("No models");
  });
});

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
