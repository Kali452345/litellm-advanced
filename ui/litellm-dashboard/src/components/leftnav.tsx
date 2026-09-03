import { useHealthReadinessDetails } from "@/app/(dashboard)/hooks/healthReadiness/useHealthReadinessDetails";
import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import { useLogout } from "@/app/(dashboard)/hooks/useLogout";
import { useTheme } from "@/contexts/ThemeContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarSeparator,
  sidebarMenuButtonVariants,
} from "@/components/shared/Sidebar";
import {
  Activity,
  ChartNoAxesColumn,
  Database,
  Gauge,
  KeyRound,
  Network,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  Route,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/cva.config";
import { all_admin_roles, isAdminRole, rolesAllowedToViewWriteScopedPages, rolesWithWriteAccess } from "../utils/roles";
import SidebarAccountMenu from "./SidebarAccountMenu/SidebarAccountMenu";
import SidebarUsageCard from "./SidebarUsageCard";
import { MIGRATED_PAGES, migratedHref, legacyPageHref } from "@/utils/migratedPages";

const ICON = { strokeWidth: 1.75 } as const;

const LOGO_CLASS_NAME = "h-7 w-auto max-w-[150px] object-contain group-data-[collapsed=true]/sidebar:w-7";

interface SidebarProps {
  setPage: (page: string) => void;
  defaultSelectedKey: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  enabledPagesInternalUsers?: string[] | null;
}

interface MenuItem {
  key: string;
  page: string;
  label: string;
  icon: React.ReactNode;
  roles?: string[];
}

interface MenuGroup {
  groupLabel: string;
  items: MenuItem[];
  roles?: string[];
}

const menuGroups: MenuGroup[] = [
  {
    groupLabel: "GATEWAY",
    items: [
      { key: "api-keys", page: "api-keys", label: "Virtual Keys", icon: <KeyRound {...ICON} /> },
      {
        key: "models",
        page: "models",
        label: "Models & Keys",
        icon: <Network {...ICON} />,
        roles: rolesAllowedToViewWriteScopedPages,
      },
      { key: "quota", page: "quota", label: "Key Rotation", icon: <Gauge {...ICON} />, roles: all_admin_roles },
      {
        key: "llm-playground",
        page: "llm-playground",
        label: "Playground",
        icon: <PlayCircle {...ICON} />,
        roles: rolesWithWriteAccess,
      },
    ],
  },
  {
    groupLabel: "INSIGHTS",
    items: [
      { key: "analytics", page: "analytics", label: "Analytics", icon: <ChartNoAxesColumn {...ICON} /> },
      { key: "logs", page: "logs", label: "Logs", icon: <Activity {...ICON} /> },
    ],
  },
  {
    groupLabel: "SETTINGS",
    roles: all_admin_roles,
    items: [
      {
        key: "router-settings",
        page: "router-settings",
        label: "Routing & Fallbacks",
        icon: <Route {...ICON} />,
        roles: all_admin_roles,
      },
      {
        key: "caching",
        page: "caching",
        label: "Response Cache",
        icon: <Database {...ICON} />,
        roles: all_admin_roles,
      },
      { key: "ui-theme", page: "ui-theme", label: "Appearance", icon: <Palette {...ICON} />, roles: all_admin_roles },
    ],
  },
];

const findMenuItemKey = (page: string): string => {
  for (const group of menuGroups) {
    const item = group.items.find((candidate) => candidate.page === page || candidate.key === page);
    if (item) return item.key;
  }
  return "api-keys";
};

const SECTION_DISPLAY: Record<string, string> = {
  GATEWAY: "Gateway",
  INSIGHTS: "Insights",
  SETTINGS: "Settings",
};

const prettify = (key: string): string =>
  key
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** Breadcrumb ("Section" / "Page") for the top bar, derived from the same nav config. */
export const getBreadcrumb = (page: string): { section: string | null; title: string } => {
  for (const group of menuGroups) {
    const item = group.items.find((candidate) => candidate.page === page);
    if (item) return { section: SECTION_DISPLAY[group.groupLabel] ?? group.groupLabel, title: item.label };
  }
  return { section: null, title: prettify(page) };
};

const Sidebar_: React.FC<SidebarProps> = ({
  setPage,
  defaultSelectedKey,
  collapsed = false,
  onToggleCollapsed,
  enabledPagesInternalUsers,
}) => {
  const { accessToken, userRole, isViewOnly } = useAuthorized();
  const { logoUrl, logoUrlDark } = useTheme();
  const [erroredDarkLogo, setErroredDarkLogo] = useState<string | null>(null);
  const { data: healthData } = useHealthReadinessDetails(accessToken);
  const logout = useLogout(accessToken);

  const version = healthData?.litellm_version;
  const selectedKey = findMenuItemKey(defaultSelectedKey);

  /**
   * An admin-saved page allowlist still applies even though the panel that wrote it is gone.
   * Honouring a stored value keeps a non-admin's nav no wider than the admin chose.
   */
  const isVisible = (item: MenuItem): boolean => {
    if (item.key === "llm-playground" && isViewOnly) return false;
    if (item.roles && !item.roles.includes(userRole)) return false;
    if (!isAdminRole(userRole) && enabledPagesInternalUsers != null) {
      return enabledPagesInternalUsers.includes(item.page);
    }
    return true;
  };

  const visibleGroups = menuGroups
    .filter((group) => !group.roles || group.roles.includes(userRole))
    .map((group) => ({ groupLabel: group.groupLabel, items: group.items.filter(isVisible) }))
    .filter((group) => group.items.length > 0);

  const handleLeafClick = (event: React.MouseEvent, item: MenuItem) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    setPage(item.page);
  };

  const renderLeaf = (item: MenuItem) => {
    const active = selectedKey === item.key;
    const href = MIGRATED_PAGES[item.page] ? migratedHref(MIGRATED_PAGES[item.page]) : legacyPageHref(item.page);
    return (
      <a
        href={href}
        onClick={(event) => handleLeafClick(event, item)}
        title={collapsed ? item.label : undefined}
        data-active={active || undefined}
        className={cn(sidebarMenuButtonVariants({ isActive: active }))}
      >
        {item.icon}
        <span className="flex-1 truncate group-data-[collapsed=true]/sidebar:hidden">{item.label}</span>
      </a>
    );
  };

  const reachableDarkLogo = logoUrlDark === erroredDarkLogo ? null : logoUrlDark;
  const brand = logoUrl ? (
    <>
      <img src={logoUrl} alt="LiteLLM Advanced" className={cn(LOGO_CLASS_NAME, "dark:hidden")} />
      <img
        src={reachableDarkLogo || logoUrl}
        alt=""
        aria-hidden
        onError={() => setErroredDarkLogo(logoUrlDark)}
        className={cn(LOGO_CLASS_NAME, "hidden dark:block")}
      />
    </>
  ) : (
    <>
      <span
        aria-hidden
        className="hidden size-7 flex-none items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground group-data-[collapsed=true]/sidebar:flex"
      >
        LA
      </span>
      <span className="flex items-baseline gap-1 whitespace-nowrap group-data-[collapsed=true]/sidebar:hidden">
        <span className="text-sm font-semibold tracking-tight text-foreground">LiteLLM</span>
        <span className="text-sm font-light tracking-tight text-muted-foreground">Advanced</span>
      </span>
    </>
  );

  return (
    <Sidebar collapsed={collapsed}>
      <SidebarHeader className="h-14 border-b border-border group-data-[collapsed=true]/sidebar:h-auto">
        <div className="flex items-center justify-between gap-2 group-data-[collapsed=true]/sidebar:flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <Link href={migratedHref("")} className="flex min-w-0 items-center" aria-label="LiteLLM Advanced home">
              {brand}
            </Link>
            {version && (
              <Badge
                variant="outline"
                render={<a href="https://docs.litellm.ai/release_notes" target="_blank" rel="noopener noreferrer" />}
                className="px-1.5 py-0 font-mono text-[10px] font-medium text-muted-foreground group-data-[collapsed=true]/sidebar:hidden"
              >
                v{version}
              </Badge>
            )}
          </div>
          {onToggleCollapsed && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex-none text-muted-foreground"
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          )}
        </div>
      </SidebarHeader>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="flex flex-col gap-0.5 px-3 pb-3">
          {visibleGroups.map((group, index) => (
            <SidebarGroup key={group.groupLabel}>
              {index > 0 && <SidebarSeparator className="hidden group-data-[collapsed=true]/sidebar:block" />}
              <SidebarGroupLabel>{group.groupLabel}</SidebarGroupLabel>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.key}>{renderLeaf(item)}</SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </ScrollArea>

      <SidebarFooter>
        {isAdminRole(userRole) && (
          <SidebarUsageCard
            accessToken={accessToken}
            collapsed={collapsed}
            onExpandRail={() => onToggleCollapsed?.()}
          />
        )}
        <SidebarAccountMenu onLogout={logout} collapsed={collapsed} />
      </SidebarFooter>
    </Sidebar>
  );
};

export default Sidebar_;

export { menuGroups };
