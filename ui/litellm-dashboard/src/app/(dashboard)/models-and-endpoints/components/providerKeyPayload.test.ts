import { describe, expect, it } from "vitest";

import type { ProviderProfile } from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import {
  buildAddProviderKeyBody,
  capsLabel,
  describeRejections,
  profileCapsSummary,
  providerKeyFormValues,
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

  it("picks only the model the row was opened from", () => {
    expect(providerKeyFormValues(profile(), "pro").models).toEqual(["pro"]);
  });

  it("falls back to the whole pool when the model is not one this provider serves", () => {
    expect(providerKeyFormValues(profile(), "ultra").models).toEqual(["flash", "pro"]);
  });

  it("prefills the way the provider's existing keys are metered, so the new key joins them", () => {
    expect(providerKeyFormValues(profile({ quota_scope: "credential" })).quota_scope).toBe("credential");
  });

  it("prefills the router's per-model default where the provider's keys say nothing", () => {
    expect(providerKeyFormValues(profile()).quota_scope).toBe("credential_model");
  });
});

describe("buildAddProviderKeyBody", () => {
  it("sends the trimmed key with a null base url, which names the provider's own url", () => {
    expect(buildAddProviderKeyBody(profile(), { api_key: "  k3  ", models: ["flash", "pro"] })).toEqual({
      provider: "gemini",
      api_key: "k3",
      api_base: null,
      quota_scope: "credential_model",
    });
  });

  it("sends the metering the form is showing, so the key is not left to inherit it", () => {
    const shared = buildAddProviderKeyBody(profile(), {
      api_key: "k3",
      models: ["flash", "pro"],
      quota_scope: "credential",
    });

    expect(shared.quota_scope).toBe("credential");
  });

  it("sends caps as numbers, not the strings the inputs hold", () => {
    const values = { api_key: "k3", rpm: "8", rpd: "250", models: ["flash", "pro"] };
    const body = buildAddProviderKeyBody(profile(), values);

    expect(body.rpm).toBe(8);
    expect(body.rpd).toBe(250);
  });

  it("leaves a blank cap out, so the provider's own cap is copied instead of overridden", () => {
    const values = { api_key: "k3", rpm: "", rpd: "", models: ["flash", "pro"] };
    const body = buildAddProviderKeyBody(profile(), values);

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

  it("reads a cleared base url as the provider's own url, not as one to inherit", () => {
    const body = buildAddProviderKeyBody(profile({ api_base: "https://gateway.example.com" }), {
      api_key: "k3",
      api_base: "   ",
      models: ["flash", "pro"],
    });

    expect(body.api_base).toBeNull();
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
