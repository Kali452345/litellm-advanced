import { useMutation, useQueryClient } from "@tanstack/react-query";

import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { fetchClient } from "@/lib/http/api";
import type { components } from "@/lib/http/schema";
import { toast } from "@/lib/toast";
import { modelPatchUpdateCall } from "@/components/networking";

import { quotaUsageKeys } from "./useQuotaUsage";

export type AddKeyModelRequest = components["schemas"]["AddKeyModelRequest"];
export type AddedKeyModel = components["schemas"]["AddedModel"];

const MODELS_LIST_KEY = ["models", "list"];

/**
 * Pause or resume one key behind a pool, without deleting it. Routing skips a
 * paused key the same way it skips a spent one, so pausing is how a failing key
 * is taken out of rotation while it is investigated.
 */
export const useToggleKeyPaused = () => {
  const { accessToken } = useAuthorized();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ modelId, blocked }: { modelId: string; blocked: boolean }) => {
      if (!accessToken) throw new Error("Missing access token");
      await modelPatchUpdateCall(accessToken, { blocked }, modelId);
    },
    onSuccess: (_, { blocked }) => {
      toast.success(blocked ? "Key paused" : "Key resumed");
      queryClient.invalidateQueries({ queryKey: quotaUsageKeys.all });
      queryClient.invalidateQueries({ queryKey: MODELS_LIST_KEY });
    },
    onError: (error) => toast.fromError(error),
  });
};

const addedModelMessage = (added: AddedKeyModel): string =>
  `Now serving ${added.model_name} with this key (${added.litellm_model})`;

/**
 * Serve another model with a key that is already set up. The credential never
 * leaves the server: only the source deployment id and the new names travel.
 */
export const useAddKeyModel = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (body: AddKeyModelRequest): Promise<AddedKeyModel | undefined> => {
      const { data } = await fetchClient.POST("/provider/keys/models", { body });
      return data;
    },
    onSuccess: (added) => {
      if (!added) {
        toast.error("The proxy answered without saying what it created");
        return;
      }
      if (added.error || !added.model_id) {
        toast.error("Could not serve another model with this key", { description: added.error ?? undefined });
        return;
      }
      toast.success(addedModelMessage(added));
      queryClient.invalidateQueries({ queryKey: quotaUsageKeys.all });
      queryClient.invalidateQueries({ queryKey: MODELS_LIST_KEY });
    },
    onError: (error) => toast.fromError(error),
  });
};
