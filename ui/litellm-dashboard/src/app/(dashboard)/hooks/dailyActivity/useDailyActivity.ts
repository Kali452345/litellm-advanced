import { useQuery } from "@tanstack/react-query";

import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { fetchClient } from "@/lib/http/api";
import type { components } from "@/lib/http/schema";
import { createQueryKeys } from "../common/queryKeysFactory";

export type DailyData = components["schemas"]["DailySpendData"];

export const dailyActivityKeys = createQueryKeys("dailyActivity");

/**
 * A guard on the page walk, not a real ceiling. The aggregated endpoint answers the whole
 * range in one call and pagination is only the fallback, so a range this wide means the
 * fallback is running against something that will time out before it finishes anyway.
 */
const MAX_PAGES = 60;

export interface DailyActivityQuery {
  startDate: string;
  endDate: string;
  userId?: string | null;
  apiKey?: string | null;
}

const asDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const rangeQuery = (from: Date, to: Date): DailyActivityQuery => ({
  startDate: asDate(from),
  endDate: asDate(to),
});

/**
 * `include_current_utc_day` needs the timezone to decide whether the range ends on the
 * caller's today, which is what keeps spend written after local midnight in the range.
 */
const wireQuery = ({ startDate, endDate, userId, apiKey }: DailyActivityQuery) => ({
  start_date: startDate,
  end_date: endDate,
  timezone: new Date().getTimezoneOffset(),
  include_current_utc_day: true,
  user_id: userId ?? null,
  api_key: apiKey ?? null,
});

const fetchPage = async (query: DailyActivityQuery, page: number) => {
  const { data } = await fetchClient.GET("/user/daily/activity", {
    params: { query: { ...wireQuery(query), page, page_size: 50 } },
  });
  return data;
};

/** Sequential on purpose: the fallback exists because the range was already too big for one call. */
const walkPages = async (query: DailyActivityQuery, page: number): Promise<DailyData[]> => {
  if (page > MAX_PAGES) return [];
  const data = await fetchPage(query, page);
  const results = data?.results ?? [];
  if (!data?.metadata?.has_more) return results;
  return [...results, ...(await walkPages(query, page + 1))];
};

const fetchDailyActivity = async (query: DailyActivityQuery): Promise<DailyData[]> => {
  const { data, error } = await fetchClient.GET("/user/daily/activity/aggregated", {
    params: { query: wireQuery(query) },
  });
  if (!error && data) return data.results;
  return walkPages(query, 1);
};

/**
 * Every day in a range, with the per-model, per-provider, per-key and per-endpoint
 * breakdown the proxy recorded for it. Read from the aggregated endpoint, which answers
 * the whole range at once; a deployment whose aggregated route fails falls back to
 * walking pages so a wide range still renders.
 */
export const useDailyActivity = (query: DailyActivityQuery) => {
  const { accessToken } = useAuthorized();

  return useQuery<DailyData[]>({
    queryKey: dailyActivityKeys.list({
      filters: {
        startDate: query.startDate,
        endDate: query.endDate,
        userId: query.userId ?? "",
        apiKey: query.apiKey ?? "",
      },
    }),
    queryFn: () => fetchDailyActivity(query),
    enabled: Boolean(accessToken),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
  });
};
