"use client";

import { SortingState } from "@tanstack/react-table";
import { Inbox } from "lucide-react";
import React, { useMemo, useState } from "react";

import { DataTable } from "@/components/shared/DataTable";
import { toast } from "@/lib/toast";
import { isProxyAdminRole } from "@/utils/roles";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import {
  AddProviderKeyRequest,
  ProviderProfile,
  useAddProviderKey,
  useProviderProfiles,
} from "@/app/(dashboard)/hooks/providerProfiles/useProviderProfiles";
import AddProviderKeyModal from "@/app/(dashboard)/models-and-endpoints/components/AddProviderKeyModal";
import { getProviderKeyColumns } from "@/app/(dashboard)/models-and-endpoints/components/ProviderKeyColumns";
import {
  describeRejections,
  summarizeAddedModels,
} from "@/app/(dashboard)/models-and-endpoints/components/providerKeyPayload";

const DEFAULT_SORTING: SortingState = [{ id: "provider", desc: false }];

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-1 py-6">
      <div className="mb-1 flex size-10 items-center justify-center rounded-lg bg-muted">
        <Inbox className="size-5 text-muted-foreground" />
      </div>
      <div className="text-sm font-medium text-foreground">No providers set up yet</div>
      <div className="text-sm text-muted-foreground">
        Add a model from Add Model first. Its provider shows up here, and every key after the first is a form with the
        shared fields already filled in.
      </div>
    </div>
  );
}

export default function ProviderKeysPanel() {
  const { userRole } = useAuthorized();
  const { data: profiles, isLoading } = useProviderProfiles();
  const addKey = useAddProviderKey();

  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
  const [adding, setAdding] = useState<ProviderProfile | null>(null);

  const canWrite = isProxyAdminRole(userRole ?? "");
  const columns = useMemo(() => getProviderKeyColumns({ canWrite, onAddKey: setAdding }), [canWrite]);

  const handleSubmit = (body: AddProviderKeyRequest) => {
    addKey.mutate(body, {
      onSuccess: (response) => {
        const outcome = summarizeAddedModels(response);
        if (outcome.kind === "none-created") {
          toast.error(`No models added to ${body.provider}`, { description: describeRejections(outcome.rejected) });
          return;
        }
        if (outcome.kind === "partly-rejected") {
          toast.warning(`Key added to ${outcome.created} of ${body.provider}'s models`, {
            description: describeRejections(outcome.rejected),
          });
        } else {
          toast.success(`Key added to ${outcome.created} ${body.provider} model${outcome.created === 1 ? "" : "s"}`);
        }
        setAdding(null);
      },
      onError: (error) => toast.fromError(error),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Every key behind a provider serves the same model names, so requests rotate across them and a key that fails or
        runs out of quota hands the same request to the next one. A per-minute and per-day cap on each key is what keeps
        a free tier from being spent before its window resets.
      </p>

      <DataTable
        data={profiles ?? []}
        columns={columns}
        getRowId={(profile) => `${profile.provider}|${profile.api_base ?? ""}`}
        sortingMode="client"
        sorting={sorting}
        onSortingChange={setSorting}
        isLoading={isLoading}
        loadingMessage="Loading providers…"
        noDataMessage={<EmptyState />}
        size="compact"
      />

      <AddProviderKeyModal
        profile={adding}
        isSaving={addKey.isPending}
        onCancel={() => setAdding(null)}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
