import { describe, expect, it } from "vitest";
import { prepareModelAddRequest } from "./handle_add_model_submit";

describe("prepareModelAddRequest", () => {
  it("returns deployment data for the most basic form", async () => {
    const formValues = {
      model_mappings: [
        {
          public_name: "Public Model",
          litellm_model: "litellm/public",
        },
      ],
      model_name: "custom-model-name",
      base_model: "gpt-4",
      team_id: "team-123",
      model_access_group: ["group-1"],
      input_cost_per_token: "2000000",
      output_cost_per_token: "1000000",
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    expect(deployments).toHaveLength(1);
    const [deployment] = deployments!;
    expect(deployment.modelName).toBe("Public Model");
    expect(deployment.litellmParamsObj.model).toBe("custom-model-name");
    expect(deployment.litellmParamsObj.input_cost_per_token).toBe(2);
    expect(deployment.litellmParamsObj.output_cost_per_token).toBe(1);
    expect(deployment.modelInfoObj.base_model).toBe("gpt-4");
    expect(deployment.modelInfoObj.access_groups).toEqual(["group-1"]);
    expect(deployment.modelInfoObj.team_id).toBe("team-123");
  });

  it("uses a lowercase fallback for unrecognized custom providers", async () => {
    const fallbackValues = {
      model_mappings: [
        {
          public_name: "Petals Model",
          litellm_model: "petals/model",
        },
      ],
      model_name: "petals/model",
      custom_llm_provider: "Petals",
    };

    const deployments = await prepareModelAddRequest({ ...fallbackValues }, "token", null);

    expect(deployments).toHaveLength(1);
    const [deployment] = deployments!;
    expect(deployment.litellmParamsObj.custom_llm_provider).toBe("petals");
  });

  it("sends the request caps as numbers, not the strings the inputs hold", async () => {
    const formValues = {
      model_mappings: [{ public_name: "Public Model", litellm_model: "litellm/public" }],
      model_name: "custom-model-name",
      rpm: "5",
      rpd: "100",
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    const [deployment] = deployments!;
    expect(deployment.litellmParamsObj.rpm).toBe(5);
    expect(deployment.litellmParamsObj.rpd).toBe(100);
  });

  it("leaves a blank cap out, so the deployment stays uncapped rather than capped at zero", async () => {
    const formValues = {
      model_mappings: [{ public_name: "Public Model", litellm_model: "litellm/public" }],
      model_name: "custom-model-name",
      rpm: "",
      rpd: undefined,
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    const [deployment] = deployments!;
    expect("rpm" in deployment.litellmParamsObj).toBe(false);
    expect("rpd" in deployment.litellmParamsObj).toBe(false);
  });

  it("keeps a zero cap, which blocks the key rather than reading as unset", async () => {
    const formValues = {
      model_mappings: [{ public_name: "Public Model", litellm_model: "litellm/public" }],
      model_name: "custom-model-name",
      rpm: "0",
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    expect(deployments![0].litellmParamsObj.rpm).toBe(0);
  });

  it("puts one key behind every model it serves, so each of them becomes its own pool", async () => {
    const formValues = {
      model_mappings: [
        { public_name: "flash", litellm_model: "gemini/gemini-2.5-flash" },
        { public_name: "pro", litellm_model: "gemini/gemini-2.5-pro" },
      ],
      api_key: "one-free-tier-key",
      rpm: "5",
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    expect(deployments!.map((deployment) => deployment.modelName)).toEqual(["flash", "pro"]);
    expect(deployments!.map((deployment) => deployment.litellmParamsObj.model)).toEqual([
      "gemini/gemini-2.5-flash",
      "gemini/gemini-2.5-pro",
    ]);
    expect(deployments!.map((deployment) => deployment.litellmParamsObj.api_key)).toEqual([
      "one-free-tier-key",
      "one-free-tier-key",
    ]);
    expect(deployments!.map((deployment) => deployment.litellmParamsObj.rpm)).toEqual([5, 5]);
  });

  it("carries the metering the form picked onto every model that key serves", async () => {
    const scopesFor = async (quota_scope: string) => {
      const deployments = await prepareModelAddRequest(
        {
          model_mappings: [
            { public_name: "flash", litellm_model: "gemini/gemini-2.5-flash" },
            { public_name: "pro", litellm_model: "gemini/gemini-2.5-pro" },
          ],
          api_key: "one-free-tier-key",
          rpm: "5",
          quota_scope,
        },
        "token",
        null,
      );
      return deployments!.map((deployment) => deployment.litellmParamsObj.quota_scope);
    };

    expect(await scopesFor("credential")).toEqual(["credential", "credential"]);
    expect(await scopesFor("credential_model")).toEqual(["credential_model", "credential_model"]);
  });

  it("ignores litellm_credential_name inside LiteLLM Params JSON", async () => {
    const formValues = {
      model_mappings: [
        {
          public_name: "Public Model",
          litellm_model: "litellm/public",
        },
      ],
      model_name: "custom-model-name",
      litellm_credential_name: "selected-credential",
      litellm_extra_params: JSON.stringify({
        litellm_credential_name: "from-json",
        timeout: 5,
      }),
    };

    const deployments = await prepareModelAddRequest({ ...formValues }, "token", null);

    expect(deployments).toHaveLength(1);
    const [deployment] = deployments!;
    expect(deployment.litellmParamsObj.litellm_credential_name).toBe("selected-credential");
    expect(deployment.litellmParamsObj.timeout).toBe(5);
  });
});

describe("prepareModelAddRequest temperature override", () => {
  const paramsFor = async (formValues: Record<string, unknown>) => {
    const deployments = await prepareModelAddRequest(
      {
        model_mappings: [{ public_name: "Public Model", litellm_model: "litellm/public" }],
        ...formValues,
      },
      "token",
      null,
    );
    return deployments![0].litellmParamsObj;
  };

  it("pins the temperature the operator typed, so a hardcoded one never reaches the provider", async () => {
    expect(await paramsFor({ temperature_mode: "pin", pinned_temperature: "0.3" })).toMatchObject({
      pinned_params: { temperature: 0.3 },
    });
  });

  it("pins a zero, which is what a deterministic deployment needs", async () => {
    expect((await paramsFor({ temperature_mode: "pin", pinned_temperature: "0" })).pinned_params).toEqual({
      temperature: 0,
    });
  });

  it("drops the param for a provider that rejects it outright", async () => {
    expect((await paramsFor({ temperature_mode: "drop" })).additional_drop_params).toEqual(["temperature"]);
  });

  it("sends neither override when the caller's value should go through", async () => {
    const params = await paramsFor({ temperature_mode: "passthrough", pinned_temperature: "0.3" });
    expect("pinned_params" in params).toBe(false);
    expect("additional_drop_params" in params).toBe(false);
  });

  it("leaves the overrides out when the form never showed the control", async () => {
    const params = await paramsFor({ model_name: "custom-model-name" });
    expect("pinned_params" in params).toBe(false);
    expect("additional_drop_params" in params).toBe(false);
  });

  it("never sends the form's own control fields as litellm params", async () => {
    const params = await paramsFor({ temperature_mode: "pin", pinned_temperature: "0.3" });
    expect("temperature_mode" in params).toBe(false);
    expect("pinned_temperature" in params).toBe(false);
  });

  it("keeps params pinned or dropped through the raw params box", async () => {
    expect(
      await paramsFor({
        temperature_mode: "pin",
        pinned_temperature: "0.3",
        litellm_extra_params: JSON.stringify({
          pinned_params: { top_p: 0.1, temperature: 1 },
          additional_drop_params: ["seed"],
        }),
      }),
    ).toMatchObject({
      pinned_params: { top_p: 0.1, temperature: 0.3 },
      additional_drop_params: ["seed"],
    });
  });

  it("wins over a temperature pin typed into the raw params box", async () => {
    expect(
      (
        await paramsFor({
          temperature_mode: "drop",
          litellm_extra_params: JSON.stringify({ pinned_params: { temperature: 1 } }),
        })
      ).pinned_params,
    ).toBeUndefined();
  });

  it("carries the override onto every model one key serves", async () => {
    const deployments = await prepareModelAddRequest(
      {
        model_mappings: [
          { public_name: "flash", litellm_model: "gemini/gemini-2.5-flash" },
          { public_name: "pro", litellm_model: "gemini/gemini-2.5-pro" },
        ],
        temperature_mode: "pin",
        pinned_temperature: "0.3",
      },
      "token",
      null,
    );

    expect(deployments!.map((deployment) => deployment.litellmParamsObj.pinned_params)).toEqual([
      { temperature: 0.3 },
      { temperature: 0.3 },
    ]);
  });
});
