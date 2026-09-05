import { useQuery } from "@tanstack/react-query";

import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { fetchClient } from "@/lib/http/api";
import type { components } from "@/lib/http/schema";
import { all_admin_roles } from "@/utils/roles";

import { createQueryKeys } from "../common/queryKeysFactory";

export type ObservedRateLimits = components["schemas"]["ObservedRateLimitsResponse"];
export type ObservedKeyLimits = components["schemas"]["ObservedKeyLimits"];
export type ObservedWindow = components["schemas"]["ObservedWindow"];

const observedRateLimitKeys = createQueryKeys("observedRateLimits");

export const OBSERVED_LOOKBACK_HOURS = 24;

const fetchObservedRateLimits = async (hours: number): Promise<ObservedRateLimits | undefined> => {
  const { data } = await fetchClient.GET("/provider/rate_limit/observed", { params: { query: { hours } } });
  return data;
};

/**
 * What providers actually allowed, derived from refusals already logged. Nothing is sent to a
 * provider to answer this, and a refusal only lands when one arrives, so it does not need polling
 * the way the live counters do.
 */
export const useObservedRateLimits = (hours: number = OBSERVED_LOOKBACK_HOURS) => {
  const { accessToken, userRole } = useAuthorized();

  return useQuery<ObservedRateLimits | undefined>({
    queryKey: observedRateLimitKeys.list({ filters: { hours } }),
    queryFn: () => fetchObservedRateLimits(hours),
    enabled: Boolean(accessToken) && all_admin_roles.includes(userRole || ""),
    staleTime: 60_000,
  });
};
