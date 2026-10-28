"use client";

import Sidebar from "@/components/leftnav";
import { getUISettings } from "@/components/networking";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { useEffect, useState } from "react";

interface SidebarProviderProps {
  setPage: (page: string) => void;
  defaultSelectedKey: string;
  sidebarCollapsed: boolean;
  onToggleCollapsed?: () => void;
}

const SidebarProvider = ({ setPage, defaultSelectedKey, sidebarCollapsed, onToggleCollapsed }: SidebarProviderProps) => {
  const { accessToken } = useAuthorized();
  const [enabledPagesInternalUsers, setEnabledPagesInternalUsers] = useState<string[] | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    getUISettings(accessToken)
      .then((settings) => {
        const pages = settings?.values?.enabled_ui_pages_internal_users;
        if (pages !== undefined) setEnabledPagesInternalUsers(pages);
      })
      .catch((error) => console.error("[SidebarProvider] Failed to fetch UI settings:", error));
  }, [accessToken]);

  return (
    <Sidebar
      setPage={setPage}
      defaultSelectedKey={defaultSelectedKey}
      collapsed={sidebarCollapsed}
      onToggleCollapsed={onToggleCollapsed}
      enabledPagesInternalUsers={enabledPagesInternalUsers}
    />
  );
};

export default SidebarProvider;
