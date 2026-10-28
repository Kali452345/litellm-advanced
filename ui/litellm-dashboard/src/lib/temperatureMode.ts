import type { components } from "@/lib/http/schema";

type LiteLLMParams = components["schemas"]["LiteLLM_Params"];

export type TemperatureOverrideParams = Pick<LiteLLMParams, "pinned_params" | "additional_drop_params">;

/**
 * What the proxy does with the temperature a caller sends. A deployment's own params are
 * only defaults the request overrides, so serving an agent harness that hardcodes a value
 * its provider refuses needs either the param taken out or the operator's value put in.
 */
export type TemperatureMode = "passthrough" | "drop" | "pin";

export const DEFAULT_TEMPERATURE_MODE: TemperatureMode = "passthrough";

const TEMPERATURE = "temperature";

export const TEMPERATURE_MODE_FIELD = "temperature_mode";
export const PINNED_TEMPERATURE_FIELD = "pinned_temperature";

export interface TemperatureModeChoice {
  readonly value: TemperatureMode;
  readonly label: string;
  readonly description: string;
}

const TEMPERATURE_MODES: Readonly<Record<TemperatureMode, Omit<TemperatureModeChoice, "value">>> = {
  passthrough: {
    label: "Send what the caller asked for",
    description: "The normal behaviour, where whatever temperature the request carries reaches the provider",
  },
  drop: {
    label: "Never send it",
    description:
      "Takes temperature out of the request entirely, for a provider that rejects the param instead of " +
      "clamping it, and leaves the model on its own default",
  },
  pin: {
    label: "Always send this value",
    description:
      "Replaces the temperature on every request with yours, so a client that hardcodes one the provider " +
      "refuses still gets a usable answer and never sees the difference",
  },
};

export const TEMPERATURE_MODE_CHOICES: readonly TemperatureModeChoice[] = (["passthrough", "drop", "pin"] as const).map(
  (value) => ({ value, ...TEMPERATURE_MODES[value] }),
);

export const temperatureModeOf = (stored: TemperatureOverrideParams | null | undefined): TemperatureMode => {
  if (stored?.pinned_params?.[TEMPERATURE] !== undefined) return "pin";
  if (stored?.additional_drop_params?.includes(TEMPERATURE)) return "drop";
  return DEFAULT_TEMPERATURE_MODE;
};

/** The pinned temperature as the number input holds it, empty when nothing is pinned. */
export const pinnedTemperatureOf = (stored: TemperatureOverrideParams | null | undefined): string => {
  const pinned = stored?.pinned_params?.[TEMPERATURE];
  return typeof pinned === "number" || typeof pinned === "string" ? String(pinned) : "";
};

/** One line for the read-only view, saying what the deployment does with the caller's temperature. */
export const temperatureModeSummary = (stored: TemperatureOverrideParams | null | undefined): string => {
  const mode = temperatureModeOf(stored);
  return mode === "pin" ? `Always send ${pinnedTemperatureOf(stored)}` : TEMPERATURE_MODES[mode].label;
};

const asFiniteNumber = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const MAX_TEMPERATURE = 2;

/** Why the value the operator typed cannot be pinned, or null when it can. */
export const pinnedTemperatureError = (raw: string): string | null => {
  const parsed = asFiniteNumber(raw);
  if (parsed === null) return "Enter the temperature to send, for example 0.3";
  if (parsed < 0 || parsed > MAX_TEMPERATURE) return `Enter a temperature between 0 and ${MAX_TEMPERATURE}`;
  return null;
};

const withoutTemperature = <T>(entries: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(entries).filter(([key]) => key !== TEMPERATURE));
const emptyToNull = <T>(value: T, isEmpty: boolean): T | null => (isEmpty ? null : value);

/**
 * The params to save for a chosen mode. Anything else the operator pinned or dropped through
 * the raw params box is carried over, and a container left empty is sent as an explicit null
 * so the proxy unsets it rather than keeping what was last saved.
 */
export const temperatureOverrideParams = (
  mode: TemperatureMode,
  pinnedTemperature: string,
  stored: TemperatureOverrideParams | null | undefined,
): TemperatureOverrideParams => {
  const otherPins = withoutTemperature(stored?.pinned_params ?? {});
  const otherDrops = (stored?.additional_drop_params ?? []).filter((param) => param !== TEMPERATURE);
  const pinnedValue = mode === "pin" ? asFiniteNumber(pinnedTemperature) : null;

  const pinned_params = pinnedValue === null ? otherPins : { ...otherPins, [TEMPERATURE]: pinnedValue };
  const additional_drop_params = mode === "drop" ? [...otherDrops, TEMPERATURE] : otherDrops;

  return {
    pinned_params: emptyToNull(pinned_params, Object.keys(pinned_params).length === 0),
    additional_drop_params: emptyToNull(additional_drop_params, additional_drop_params.length === 0),
  };
};

/**
 * The override merged into the params a save has already built, so it wins over the raw params box.
 * A container that was never stored stays absent instead of going out as a null, which keeps an
 * edit that never touched temperature from carrying a pointless clear.
 */
export const withTemperatureOverride = (
  params: TemperatureOverrideParams & Readonly<Record<string, unknown>>,
  mode: TemperatureMode,
  pinnedTemperature: string,
): Record<string, unknown> => {
  const override = temperatureOverrideParams(mode, pinnedTemperature, params);
  const applied = Object.entries(override).filter(([param, value]) => value !== null || param in params);
  return { ...params, ...Object.fromEntries(applied) };
};
