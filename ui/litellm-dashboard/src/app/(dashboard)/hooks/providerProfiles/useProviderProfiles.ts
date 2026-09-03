import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createQueryKeys } from "../common/queryKeysFactory";
import { all_admin_roles } from "@/utils/roles";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { fetchClient } from "@/lib/http/api";
import type { components } from "@/lib/http/schema";

export type ProviderProfile = components["schemas"]["ProviderProfile"];
export type ProviderProfileModel = components["schemas"]["ProviderProfileModel"];
export type AddProviderKeyRequest = components["schemas"]["AddProviderKeyRequest"];
export type AddProviderKeyResponse = components["schemas"]["AddProviderKeyResponse"];
export type AddedModel = components["schemas"]["AddedModel"];
export type ProbeRateLimitRequest = components["schemas"]["ProbeRateLimitRequest"];
export type RateLimitProbeResponse = components["schemas"]["RateLimitProbeResponse"];

export const providerProfileKeys = createQueryKeys("providerProfiles");

const fetchProviderProfiles = async (): Promise<ProviderProfile[]> => {
  const { data } = await fetchClient.GET("/provider/profiles");
  return data?.profiles ?? [];
};

/**
 * What each provider is already set up with, derived from the deployments the router is
 * running. A profile is a view, not a stored record, so it cannot go stale against them.
 */
export const useProviderProfiles = () => {
  const { accessToken, userRole } = useAuthorized();

  return useQuery<ProviderProfile[]>({
    queryKey: providerProfileKeys.list({}),
    queryFn: fetchProviderProfiles,
    enabled: Boolean(accessToken) && all_admin_roles.includes(userRole || ""),
  });
};

const addProviderKey = async (body: AddProviderKeyRequest): Promise<AddProviderKeyResponse | undefined> => {
  const { data } = await fetchClient.POST("/provider/keys", { body });
  return data;
};

export const useAddProviderKey = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: addProviderKey,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: providerProfileKeys.all });
      queryClient.invalidateQueries({ queryKey: ["models", "list"] });
    },
  });
};

const probeRateLimit = async (body: ProbeRateLimitRequest): Promise<RateLimitProbeResponse | undefined> => {
  const { data } = await fetchClient.POST("/provider/rate_limit/probe", { body });
  return data;
};

/**
 * A reading taken by spending the key's own allowance, not state the proxy holds, so nothing is
 * cached and nothing is invalidated. It answers only once the provider refuses, which is up to the
 * minute a per-minute cap is counted over.
 */
export const useProbeRateLimit = () => useMutation({ mutationFn: probeRateLimit });
