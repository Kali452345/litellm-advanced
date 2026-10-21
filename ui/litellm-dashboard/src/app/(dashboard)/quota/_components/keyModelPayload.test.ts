import { describe, expect, it } from "vitest";

import { planKeyModel } from "./keyModelPayload";

describe("planKeyModel", () => {
  it("sends the source deployment id with both names", () => {
    const plan = planKeyModel("d1", { modelName: "smart", litellmModel: "openai/gpt-5" });

    expect(plan).toEqual({
      kind: "ready",
      request: { model_id: "d1", model_name: "smart", litellm_model: "openai/gpt-5" },
    });
  });

  it("trims names rather than sending what the provider would reject", () => {
    const plan = planKeyModel("d1", { modelName: "  smart  ", litellmModel: "  openai/gpt-5  " });

    expect(plan).toMatchObject({ request: { model_name: "smart", litellm_model: "openai/gpt-5" } });
  });

  it("refuses a public name that is blank", () => {
    const plan = planKeyModel("d1", { modelName: "   ", litellmModel: "openai/gpt-5" });

    expect(plan).toMatchObject({ kind: "blocked", field: "modelName" });
  });

  it("refuses a provider string that is blank", () => {
    const plan = planKeyModel("d1", { modelName: "smart", litellmModel: "   " });

    expect(plan).toMatchObject({ kind: "blocked", field: "litellmModel" });
  });
});
