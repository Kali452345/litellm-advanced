import type {
  ProbeRateLimitRequest,
  ProviderProfile,
  RateLimitProbeResponse,
} from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import type { ProviderKeyFormValues } from "./providerKeyPayload";

const MAX_REQUESTS = 60;
const LONGEST_PER_MINUTE_WAIT_SECONDS = 60;

export interface CapFill {
  field: "rpm" | "rpd";
  requests: number;
}

export interface ProbeNote {
  headline: string;
  detail: string;
  fill: CapFill | null;
}

export type ProbePlan = { kind: "ready"; request: ProbeRateLimitRequest } | { kind: "blocked"; note: ProbeNote };

const blocked = (headline: string, detail: string): ProbePlan => ({
  kind: "blocked",
  note: { headline, detail, fill: null },
});

/**
 * The probe goes straight to the provider rather than through the router, so it needs the model
 * string the provider itself is sent, not the public name the table shows.
 */
export const planRateLimitProbe = (profile: ProviderProfile | null, values: ProviderKeyFormValues): ProbePlan => {
  if (!profile) return blocked("No provider to test", "Open this form from a provider first");

  const apiKey = values.api_key.trim();
  if (apiKey === "") {
    return blocked("Paste the key first", "Only real requests can find a cap the provider never published");
  }

  const target = profile.models.find((model) => (values.models ?? []).includes(model.model_name));
  if (!target) return blocked("Pick a model first", "The test requests have to go to one of this provider's models");

  const apiBase = values.api_base?.trim() ?? "";
  return {
    kind: "ready",
    request: {
      model: target.litellm_model,
      api_key: apiKey,
      api_base: apiBase === "" ? null : apiBase,
      api_version: profile.api_version ?? null,
      max_requests: MAX_REQUESTS,
    },
  };
};

const requests = (count: number): string => `${count} request${count === 1 ? "" : "s"}`;

const wait = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
};

const spent = (response: RateLimitProbeResponse): string =>
  `${requests(response.requests_sent)} spent in ${Math.round(response.seconds_elapsed)} seconds`;

/**
 * A refusal that names tokens or concurrency did not measure a per-minute request cap, and a
 * retry-after longer than a minute means the count is the per-day cap instead. Getting either wrong
 * would hand the user a number to type into the wrong field, so neither offers one.
 */
const readRefusal = (response: RateLimitProbeResponse): ProbeNote => {
  if (response.rate_limit_type === "tokens") {
    return {
      headline: `Ran out of tokens after ${requests(response.accepted)}`,
      detail: "The ceiling it hit counts tokens, so that count is not a request cap",
      fill: null,
    };
  }
  if (response.rate_limit_type === "concurrent_requests") {
    return {
      headline: `Hit a concurrency limit after ${requests(response.accepted)}`,
      detail: "The ceiling it hit counts requests in flight at once, so that count is not a per-minute cap",
      fill: null,
    };
  }

  const retryAfter = response.retry_after_seconds ?? null;
  if (retryAfter !== null && retryAfter > LONGEST_PER_MINUTE_WAIT_SECONDS) {
    return {
      headline: `Accepted ${requests(response.accepted)}, then refused for ${wait(retryAfter)}`,
      detail: `That wait is longer than a minute, so ${response.accepted} is the per-day cap rather than the per-minute one`,
      fill: { field: "rpd", requests: response.accepted },
    };
  }
  return {
    headline: `Accepted ${requests(response.accepted)}, then refused`,
    detail: `That is this key's per-minute cap, with ${spent(response)}`,
    fill: { field: "rpm", requests: response.accepted },
  };
};

export const readRateLimitProbe = (response: RateLimitProbeResponse | undefined): ProbeNote => {
  if (!response) return { headline: "The proxy answered without a reading", detail: "Try the test again", fill: null };

  switch (response.outcome) {
    case "rate_limited":
      return readRefusal(response);
    case "already_limited":
      return {
        headline: "This key had nothing left to measure",
        detail: response.retry_after_seconds
          ? `It refused the first request and asked for ${wait(response.retry_after_seconds)}, so test again after that`
          : "It refused the very first request, so wait for its window to roll over and test again",
        fill: null,
      };
    case "ceiling_reached":
      return {
        headline: `Accepted all ${requests(response.accepted)} without refusing`,
        detail: "Its cap is at least that, and the test stops there rather than spending more of the key",
        fill: null,
      };
    case "deadline_reached":
      return {
        headline: `Accepted ${requests(response.accepted)} before the minute ran out`,
        detail:
          "A per-minute cap can only be measured inside one minute, and no refusal came in that time, so its cap is at least that",
        fill: null,
      };
    case "refused":
      return {
        headline: "The provider refused for something other than a rate limit",
        detail: response.message ?? "Check the key, the model and the base url",
        fill: null,
      };
  }
};

export const capFillLabel = (fill: CapFill): string =>
  `Use ${fill.requests} as Requests Per ${fill.field === "rpm" ? "Minute" : "Day"}`;
