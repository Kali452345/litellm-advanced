import useAuthorized from "@/app/(dashboard)/hooks/useAuthorized";
import {
  emitLocalStorageChange,
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "@/utils/localStorageUtils";
import { navAccountDisplayName } from "@/components/Navbar/navDisplayName";
import { ChevronDown, Crown, LogOut, Mail, ShieldCheck, User } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import CopyButton from "@/components/shared/CopyButton";
import React, { useEffect, useState } from "react";

function hueFromString(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = seed.charCodeAt(i) + ((h << 5) - h);
  }
  return Math.abs(h) % 360;
}

function initialsFromIdentity(email: string | null, userId: string | null): string {
  const local = email?.split("@")[0]?.trim();
  if (local) {
    const parts = local
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]!.charAt(0)}${parts[1]!.charAt(0)}`.toUpperCase();
    }
    if (parts.length === 1) {
      const p = parts[0]!;
      return p.length >= 2 ? p.slice(0, 2).toUpperCase() : `${p.charAt(0)}`.toUpperCase();
    }
  }
  if (userId && userId.length >= 2) {
    return userId.slice(0, 2).toUpperCase();
  }
  if (userId && userId.length === 1) {
    return `${userId.toUpperCase()}•`;
  }
  return "?";
}

interface UserDropdownProps {
  onLogout: () => void;
}

const UserDropdown: React.FC<UserDropdownProps> = ({ onLogout }) => {
  const { userId, userEmail, userRoleLabel: userRole, premiumUser } = useAuthorized();
  const [disableShowNewBadge, setDisableShowNewBadge] = useState(false);

  useEffect(() => {
    const storedValue = getLocalStorageItem("disableShowNewBadge");
    setDisableShowNewBadge(storedValue === "true");
  }, []);

  const renderUserInfoSection = () => (
    <div className="flex w-full flex-col gap-2 p-3 text-sm">
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mail className="size-4" />
          <span className="text-muted-foreground">{userEmail || "-"}</span>
        </div>
        {premiumUser ? (
          <Badge>
            <Crown className="size-3" />
            Premium
          </Badge>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" />}>
                <Crown className="size-3" />
                Standard
              </TooltipTrigger>
              <TooltipContent side="left">Upgrade to Premium for advanced features</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <Separator className="my-2" />
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <User className="size-4" />
          <span className="text-muted-foreground">User ID</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="max-w-[150px] truncate" title={userId || "-"}>
            {userId || "-"}
          </span>
          <CopyButton value={userId} label="Copy User ID" />
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          <span className="text-muted-foreground">Role</span>
        </div>
        <span>{userRole}</span>
      </div>
      <Separator className="my-2" />
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-muted-foreground">Hide New Feature Indicators</span>
        <Switch
          size="sm"
          checked={disableShowNewBadge}
          onCheckedChange={(checked) => {
            setDisableShowNewBadge(checked);
            if (checked) {
              setLocalStorageItem("disableShowNewBadge", "true");
              emitLocalStorageChange("disableShowNewBadge");
            } else {
              removeLocalStorageItem("disableShowNewBadge");
              emitLocalStorageChange("disableShowNewBadge");
            }
          }}
          aria-label="Toggle hide new feature indicators"
        />
      </div>
    </div>
  );

  const seed = userEmail || userId || "user";
  const initials = initialsFromIdentity(userEmail, userId);
  const hue = hueFromString(seed);
  const displayName = navAccountDisplayName(userEmail, userId);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex! max-w-[min(200px,34vw)] items-center gap-2 rounded-md! py-0.5! pl-1! pr-2! transition-colors hover:bg-accent!"
            aria-label={`Account menu — ${userRole ?? "Unknown role"} — signed in as ${userEmail || userId || "unknown"}`}
            aria-haspopup="dialog"
          />
        }
      >
        <Avatar className="shadow-inner ring-1 ring-black/5" aria-hidden>
          <AvatarFallback className="font-semibold text-white" style={{ backgroundColor: `hsl(${hue} 46% 38%)` }}>
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="hidden min-w-0 truncate text-left text-sm font-medium leading-none text-foreground md:inline">
          {displayName}
        </span>
        <ChevronDown className="hidden size-2.5 shrink-0 text-muted-foreground md:inline" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-auto gap-0 rounded-lg bg-card p-1 shadow-lg"
        data-testid="user-dropdown-panel"
      >
        {renderUserInfoSection()}
        <Separator />
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
        >
          <LogOut className="size-4" />
          Logout
        </button>
      </PopoverContent>
    </Popover>
  );
};

export default UserDropdown;
