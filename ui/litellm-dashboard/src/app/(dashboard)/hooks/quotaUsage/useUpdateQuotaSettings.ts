import { useMutation, useQueryClient } from "@tanstack/react-query";

import { fetchClient } from "@/lib/http/api";

import type { QuotaSettingsUpdate } from "@/app/(dashboard)/quota/_lib/quotaSettingsForm";

import { quotaUsageKeys } from "./useQuotaUsage";

const saveQuotaSettings = async (update: QuotaSettingsUpdate): Promise<void> => {
  await fetchClient.POST("/config/update", { body: { router_settings: update } });
};

/**
 * Turn quota routing on or off, and set how long a request may be held, on a running proxy.
 *
 * The proxy writes the section to its config row and applies it to the router it is already
 * serving from, so no restart is involved. The refetch is awaited before the mutation settles,
 * which keeps the form from flicking back to the old value on its way to the new one.
 */
export const useUpdateQuotaSettings = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: saveQuotaSettings,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: quotaUsageKeys.all }),
  });
};
