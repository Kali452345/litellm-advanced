import { useQuery } from "@tanstack/react-query";
import { createQueryKeys } from "../common/queryKeysFactory";
import { all_admin_roles } from "@/utils/roles";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { fetchClient } from "@/lib/http/api";
import type { components } from "@/lib/http/schema";

export type ModelQuotaUsage = components["schemas"]["ModelQuotaUsageResponse"];
export type PoolQuotaUsage = components["schemas"]["PoolQuotaUsage"];
export type KeyQuotaUsage = components["schemas"]["KeyQuotaUsage"];
export type QuotaWindowUsage = components["schemas"]["QuotaWindowUsage"];

export const quotaUsageKeys = createQueryKeys("quotaUsage");

/** A minute window rolls over within a minute, so a slower poll shows counts that already reset. */
export const QUOTA_POLL_MS = 10_000;

const fetchQuotaUsage = async (): Promise<ModelQuotaUsage | undefined> => {
  const { data } = await fetchClient.GET("/model/quota/usage");
  return data;
};

/**
 * What every key behind every pool has spent of its per-minute and per-day caps.
 *
 * Polled rather than fetched once: this is the live state routing acts on, and a spent
 * key that has since rolled over is the difference between "the pool is stuck" and
 * "the pool is working".
 */
export const useQuotaUsage = (pollMs: number = QUOTA_POLL_MS) => {
  const { accessToken, userRole } = useAuthorized();

  return useQuery<ModelQuotaUsage | undefined>({
    queryKey: quotaUsageKeys.list({}),
    queryFn: fetchQuotaUsage,
    enabled: Boolean(accessToken) && all_admin_roles.includes(userRole || ""),
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
  });
};
