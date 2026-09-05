import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPERATURE_MODE,
  pinnedTemperatureError,
  pinnedTemperatureOf,
  temperatureModeOf,
  temperatureModeSummary,
  temperatureOverrideParams,
  withTemperatureOverride,
  type TemperatureOverrideParams,
} from "./temperatureMode";

describe("temperatureModeOf", () => {
  it("reads a stored pin", () => {
    expect(temperatureModeOf({ pinned_params: { temperature: 0.3 } })).toBe("pin");
  });

  it("reads a pin of zero, which is the value a deterministic deployment wants", () => {
    expect(temperatureModeOf({ pinned_params: { temperature: 0 } })).toBe("pin");
  });

  it("reads a stored drop", () => {
    expect(temperatureModeOf({ additional_drop_params: ["temperature"] })).toBe("drop");
  });

  it("ignores a drop list that names other params", () => {
    expect(temperatureModeOf({ additional_drop_params: ["top_p", "seed"] })).toBe("passthrough");
  });

  it("prefers the pin when a hand-written config set both", () => {
    expect(temperatureModeOf({ pinned_params: { temperature: 0.3 }, additional_drop_params: ["temperature"] })).toBe(
      "pin",
    );
  });

  it.each([{}, null, undefined, { pinned_params: null, additional_drop_params: null }])(
    "falls back to the default for %s",
    (stored) => {
      expect(temperatureModeOf(stored as TemperatureOverrideParams | null | undefined)).toBe(DEFAULT_TEMPERATURE_MODE);
    },
  );
});

describe("pinnedTemperatureOf", () => {
  it("fills the input with the stored value", () => {
    expect(pinnedTemperatureOf({ pinned_params: { temperature: 0.3 } })).toBe("0.3");
  });

  it("keeps a pinned zero visible rather than blanking the field", () => {
    expect(pinnedTemperatureOf({ pinned_params: { temperature: 0 } })).toBe("0");
  });

  it("is empty when nothing is pinned", () => {
    expect(pinnedTemperatureOf({ pinned_params: { top_p: 0.1 } })).toBe("");
  });
});

describe("temperatureModeSummary", () => {
  it("names the pinned value so the read-only view shows what callers actually get", () => {
    expect(temperatureModeSummary({ pinned_params: { temperature: 0.3 } })).toBe("Always send 0.3");
  });

  it("names a pinned zero rather than reading as unset", () => {
    expect(temperatureModeSummary({ pinned_params: { temperature: 0 } })).toBe("Always send 0");
  });

  it("says the param is dropped", () => {
    expect(temperatureModeSummary({ additional_drop_params: ["temperature"] })).toBe("Never send it");
  });

  it("says the caller's value goes through when nothing is set", () => {
    expect(temperatureModeSummary(null)).toBe("Send what the caller asked for");
  });
});

describe("temperatureOverrideParams", () => {
  it("pins the value the operator typed", () => {
    expect(temperatureOverrideParams("pin", "0.3", null)).toEqual({
      pinned_params: { temperature: 0.3 },
      additional_drop_params: null,
    });
  });

  it("pins zero rather than treating an empty-looking number as unset", () => {
    expect(temperatureOverrideParams("pin", "0", null).pinned_params).toEqual({ temperature: 0 });
  });

  it("drops the param instead of pinning it", () => {
    expect(temperatureOverrideParams("drop", "", null)).toEqual({
      pinned_params: null,
      additional_drop_params: ["temperature"],
    });
  });

  it("sends nulls for passthrough so the proxy unsets what was saved before", () => {
    expect(temperatureOverrideParams("passthrough", "0.3", { pinned_params: { temperature: 0.3 } })).toEqual({
      pinned_params: null,
      additional_drop_params: null,
    });
  });

  it("takes the drop off when switching to a pin", () => {
    expect(temperatureOverrideParams("pin", "0.3", { additional_drop_params: ["temperature"] })).toEqual({
      pinned_params: { temperature: 0.3 },
      additional_drop_params: null,
    });
  });

  it("takes the pin off when switching to a drop", () => {
    expect(temperatureOverrideParams("drop", "", { pinned_params: { temperature: 0.3 } })).toEqual({
      pinned_params: null,
      additional_drop_params: ["temperature"],
    });
  });

  it("keeps params the operator pinned or dropped through the raw params box", () => {
    expect(
      temperatureOverrideParams("pin", "0.3", {
        pinned_params: { top_p: 0.1, temperature: 1 },
        additional_drop_params: ["seed", "temperature"],
      }),
    ).toEqual({
      pinned_params: { top_p: 0.1, temperature: 0.3 },
      additional_drop_params: ["seed"],
    });
  });

  it("never lists temperature twice when it was already dropped", () => {
    expect(
      temperatureOverrideParams("drop", "", { additional_drop_params: ["temperature"] }).additional_drop_params,
    ).toEqual(["temperature"]);
  });

  it.each(["", "   ", "abc", "NaN", "Infinity"])("pins nothing for the unusable value %o", (raw) => {
    expect(temperatureOverrideParams("pin", raw, null).pinned_params).toBeNull();
  });
});

describe("pinnedTemperatureError", () => {
  it.each(["0", "0.3", "1", "2", " 1.5 "])("accepts the usable value %o", (raw) => {
    expect(pinnedTemperatureError(raw)).toBeNull();
  });

  it.each(["", "   ", "abc", "NaN", "Infinity"])("asks for a number instead of %o", (raw) => {
    expect(pinnedTemperatureError(raw)).toBe("Enter the temperature to send, for example 0.3");
  });

  it.each(["-0.1", "2.1", "100"])("rejects %o, which no provider accepts", (raw) => {
    expect(pinnedTemperatureError(raw)).toBe("Enter a temperature between 0 and 2");
  });
});

describe("withTemperatureOverride", () => {
  it("leaves the rest of the save alone", () => {
    expect(withTemperatureOverride({ model: "gemini/gemini-2.5-flash", rpm: 5 }, "pin", "0.3")).toEqual({
      model: "gemini/gemini-2.5-flash",
      rpm: 5,
      pinned_params: { temperature: 0.3 },
    });
  });

  it("clears a stored pin so the caller's value goes through again", () => {
    expect(withTemperatureOverride({ pinned_params: { temperature: 0.3 } }, "passthrough", "")).toEqual({
      pinned_params: null,
    });
  });

  it("carries no clear for a container that was never stored", () => {
    const saved = withTemperatureOverride({ model: "gemini/gemini-2.5-flash" }, "passthrough", "");

    expect(saved).toEqual({ model: "gemini/gemini-2.5-flash" });
    expect(saved).not.toHaveProperty("pinned_params");
    expect(saved).not.toHaveProperty("additional_drop_params");
  });

  it("clears the drop list it stored earlier without touching one it never wrote", () => {
    expect(withTemperatureOverride({ additional_drop_params: ["temperature"] }, "pin", "0.3")).toEqual({
      pinned_params: { temperature: 0.3 },
      additional_drop_params: null,
    });
  });

  it("beats a temperature the operator typed into the raw params box", () => {
    expect(withTemperatureOverride({ pinned_params: { temperature: 1, top_p: 0.1 } }, "pin", "0.3")).toEqual({
      pinned_params: { temperature: 0.3, top_p: 0.1 },
    });
  });

  it("drops the param while keeping what the raw params box dropped", () => {
    expect(withTemperatureOverride({ additional_drop_params: ["seed"] }, "drop", "")).toEqual({
      additional_drop_params: ["seed", "temperature"],
    });
  });
});
