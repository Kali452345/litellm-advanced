import { describe, expect, it } from "vitest";

import type {
  ProviderProfile,
  RateLimitProbeResponse,
} from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import { capFillLabel, planRateLimitProbe, readRateLimitProbe } from "./rateLimitProbe";

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

const reading = (overrides: Partial<RateLimitProbeResponse> = {}): RateLimitProbeResponse => ({
  outcome: "rate_limited",
  accepted: 5,
  requests_sent: 8,
  seconds_elapsed: 3.4,
  ...overrides,
});

describe("planRateLimitProbe", () => {
  it("sends the model string the provider itself is sent, not the name the table shows", () => {
    const plan = planRateLimitProbe(profile(), { api_key: "k3", models: ["pro"] });

    expect(plan).toEqual({
      kind: "ready",
      request: {
        model: "gemini/gemini-2.5-pro",
        api_key: "k3",
        api_base: null,
        api_version: null,
        max_requests: 60,
      },
    });
  });

  it("tests the first of the picked models, in the order the provider serves them", () => {
    const plan = planRateLimitProbe(profile(), { api_key: "k3", models: ["pro", "flash"] });

    expect(plan).toMatchObject({ request: { model: "gemini/gemini-2.5-flash" } });
  });

  it("measures the key at the url and api version this provider is reached at", () => {
    const plan = planRateLimitProbe(profile({ api_version: "2024-06-01" }), {
      api_key: "k3",
      api_base: "  https://one.example.com  ",
      models: ["flash"],
    });

    expect(plan).toMatchObject({
      request: { api_base: "https://one.example.com", api_version: "2024-06-01" },
    });
  });

  it("names the provider's own url when the base url is cleared", () => {
    const plan = planRateLimitProbe(profile({ api_base: "https://one.example.com" }), {
      api_key: "k3",
      api_base: "",
      models: ["flash"],
    });

    expect(plan).toMatchObject({ request: { api_base: null } });
  });

  it("trims the key rather than measuring one the provider would reject", () => {
    const plan = planRateLimitProbe(profile(), { api_key: "  k3  ", models: ["flash"] });

    expect(plan).toMatchObject({ request: { api_key: "k3" } });
  });

  it("will not spend requests without a key to measure", () => {
    const plan = planRateLimitProbe(profile(), { api_key: "   ", models: ["flash"] });

    expect(plan).toEqual({
      kind: "blocked",
      note: {
        headline: "Paste the key first",
        detail: "Only real requests can find a cap the provider never published",
        fill: null,
      },
    });
  });

  it("will not spend requests with no model for them to go to", () => {
    const plan = planRateLimitProbe(profile(), { api_key: "k3", models: [] });

    expect(plan).toMatchObject({ kind: "blocked", note: { headline: "Pick a model first" } });
  });

  it("will not spend requests on a model this provider does not serve", () => {
    const plan = planRateLimitProbe(profile(), { api_key: "k3", models: ["ultra"] });

    expect(plan).toMatchObject({ kind: "blocked", note: { headline: "Pick a model first" } });
  });
});

describe("readRateLimitProbe", () => {
  it("reads the accepted count as the per-minute cap and offers it for that field", () => {
    const note = readRateLimitProbe(reading({ accepted: 5, rate_limit_type: "requests" }));

    expect(note.headline).toBe("Accepted 5 requests, then refused");
    expect(note.fill).toEqual({ field: "rpm", requests: 5 });
  });

  it("counts one accepted request without pluralising it", () => {
    expect(readRateLimitProbe(reading({ accepted: 1 })).headline).toBe("Accepted 1 request, then refused");
  });

  it("says what the test spent, so the cost of the reading is visible", () => {
    const note = readRateLimitProbe(reading({ accepted: 5, requests_sent: 8, seconds_elapsed: 3.4 }));

    expect(note.detail).toBe("That is this key's per-minute cap, with 8 requests spent in 3 seconds");
  });

  it("offers the count as the per-day cap when the provider asks to wait longer than a minute", () => {
    const note = readRateLimitProbe(reading({ accepted: 40, retry_after_seconds: 86400 }));

    expect(note.headline).toBe("Accepted 40 requests, then refused for 24 hours");
    expect(note.fill).toEqual({ field: "rpd", requests: 40 });
  });

  it("keeps a refusal that frees up within the minute on the per-minute field", () => {
    const note = readRateLimitProbe(reading({ accepted: 5, retry_after_seconds: 30 }));

    expect(note.fill).toEqual({ field: "rpm", requests: 5 });
  });

  it("offers no number when the ceiling the provider named counts tokens", () => {
    const note = readRateLimitProbe(reading({ accepted: 5, rate_limit_type: "tokens" }));

    expect(note.headline).toBe("Ran out of tokens after 5 requests");
    expect(note.fill).toBeNull();
  });

  it("offers no number when the ceiling the provider named counts requests in flight", () => {
    const note = readRateLimitProbe(reading({ accepted: 5, rate_limit_type: "concurrent_requests" }));

    expect(note.headline).toBe("Hit a concurrency limit after 5 requests");
    expect(note.fill).toBeNull();
  });

  it("offers no number for a key that had nothing left, so a cap of 0 is never typed in", () => {
    const note = readRateLimitProbe(reading({ outcome: "already_limited", accepted: 0, requests_sent: 4 }));

    expect(note.headline).toBe("This key had nothing left to measure");
    expect(note.fill).toBeNull();
  });

  it("says how long an exhausted key asked for, when it says", () => {
    const note = readRateLimitProbe(reading({ outcome: "already_limited", accepted: 0, retry_after_seconds: 120 }));

    expect(note.detail).toContain("asked for 2 minutes");
  });

  it("reports a floor rather than a cap when the provider never refused", () => {
    const note = readRateLimitProbe(reading({ outcome: "ceiling_reached", accepted: 60, requests_sent: 60 }));

    expect(note.headline).toBe("Accepted all 60 requests without refusing");
    expect(note.detail).toContain("at least that");
    expect(note.fill).toBeNull();
  });

  it("reports a floor when the minute a cap is counted over ran out first", () => {
    const note = readRateLimitProbe(reading({ outcome: "deadline_reached", accepted: 44, seconds_elapsed: 50 }));

    expect(note.headline).toBe("Accepted 44 requests before the minute ran out");
    expect(note.fill).toBeNull();
  });

  it("repeats what the provider said when it refused for another reason", () => {
    const note = readRateLimitProbe(reading({ outcome: "refused", accepted: 0, message: "401 API key not valid" }));

    expect(note.detail).toBe("401 API key not valid");
    expect(note.fill).toBeNull();
  });

  it("still says something when the proxy answers with no body at all", () => {
    expect(readRateLimitProbe(undefined).fill).toBeNull();
    expect(readRateLimitProbe(undefined).headline).toBe("The proxy answered without a reading");
  });
});

describe("capFillLabel", () => {
  it("names the field the measured number belongs in", () => {
    expect(capFillLabel({ field: "rpm", requests: 5 })).toBe("Use 5 as Requests Per Minute");
    expect(capFillLabel({ field: "rpd", requests: 40 })).toBe("Use 40 as Requests Per Day");
  });
});
