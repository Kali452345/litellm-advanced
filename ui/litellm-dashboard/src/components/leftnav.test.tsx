import { fireEvent, screen } from "@testing-library/react";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../tests/test-utils";
import Sidebar, { menuGroups, getBreadcrumb } from "./leftnav";
import { MIGRATED_PAGES } from "@/utils/migratedPages";

vi.mock("../utils/roles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/roles")>()),
  all_admin_roles: ["admin", "admin_viewer"],
  rolesWithWriteAccess: ["admin", "internal"],
  rolesAllowedToViewWriteScopedPages: ["admin", "internal", "admin_viewer"],
  isAdminRole: (role: string) => role === "admin" || role === "admin_viewer",
}));

const { mockUseAuthorized } = vi.hoisted(() => ({
  mockUseAuthorized: vi.fn(() => ({
    userId: "test-user-id",
    accessToken: "test-access-token",
    userRole: "admin",
    isViewOnly: false,
    token: "test-token",
    userEmail: "test@example.com",
    premiumUser: false,
  })),
}));

vi.mock("@/app/(dashboard)/hooks/useAuthorized", () => ({ default: mockUseAuthorized }));

const unbrandedTheme = () => ({
  logoUrl: null as string | null,
  logoUrlDark: null as string | null,
  faviconUrl: null as string | null,
  setLogoUrl: vi.fn(),
  setLogoUrlDark: vi.fn(),
  setFaviconUrl: vi.fn(),
});
let mockUseThemeImpl = unbrandedTheme;
vi.mock("@/contexts/ThemeContext", () => ({ useTheme: () => mockUseThemeImpl() }));

vi.mock("@/app/(dashboard)/hooks/healthReadiness/useHealthReadinessDetails", () => ({
  useHealthReadinessDetails: () => ({ data: { litellm_version: "9.9.9" } }),
}));
vi.mock("@/app/(dashboard)/hooks/useLogout", () => ({ useLogout: () => vi.fn() }));

const navLink = (label: string) => screen.getByRole("link", { name: label });
const labels = () => screen.getAllByRole("link").map((link) => link.textContent?.trim());

const asRole = (userRole: string, extra: Record<string, unknown> = {}) =>
  mockUseAuthorized.mockReturnValue({
    userId: "u",
    accessToken: "t",
    userRole,
    isViewOnly: false,
    token: "t",
    userEmail: "u@example.com",
    premiumUser: false,
    ...extra,
  } as ReturnType<typeof mockUseAuthorized>);

describe("Sidebar (leftnav)", () => {
  const defaultProps = { setPage: vi.fn(), defaultSelectedKey: "api-keys", collapsed: false };

  afterEach(() => {
    mockUseAuthorized.mockReset();
    mockUseThemeImpl = unbrandedTheme;
  });

  it("brands the product as LiteLLM Advanced and links it to the UI home route", () => {
    renderWithProviders(<Sidebar {...defaultProps} />);

    const home = screen.getByRole("link", { name: /litellm advanced home/i });
    expect(home).toHaveAttribute("href", "/ui");
    expect(home).toHaveTextContent("LiteLLM");
    expect(home).toHaveTextContent("Advanced");
  });

  it("prefers a configured dark logo over the light one, and falls back when it fails to load", () => {
    mockUseThemeImpl = () => ({
      ...unbrandedTheme(),
      logoUrl: "https://cdn.example.com/logo.png",
      logoUrlDark: "https://cdn.example.com/gone.png",
    });
    renderWithProviders(<Sidebar {...defaultProps} />);

    const [light, dark] = Array.from(
      screen.getByRole("link", { name: /litellm advanced home/i }).querySelectorAll("img"),
    );
    expect(light).toHaveAttribute("src", "https://cdn.example.com/logo.png");
    expect(dark).toHaveAttribute("src", "https://cdn.example.com/gone.png");

    fireEvent.error(dark);

    expect(dark).toHaveAttribute("src", "https://cdn.example.com/logo.png");
  });

  it("shows an admin every page in the trimmed nav", () => {
    asRole("admin");
    renderWithProviders(<Sidebar {...defaultProps} />);

    expect(labels()).toEqual(
      expect.arrayContaining([
        "Overview",
        "Virtual Keys",
        "Models & Keys",
        "Key Rotation",
        "Playground",
        "Analytics",
        "Logs",
        "Routing & Fallbacks",
        "Response Cache",
        "Appearance",
      ]),
    );
  });

  it("hides admin-only pages from an internal user", () => {
    asRole("internal");
    renderWithProviders(<Sidebar {...defaultProps} />);

    expect(labels()).toEqual(
      expect.arrayContaining(["Overview", "Virtual Keys", "Models & Keys", "Playground", "Analytics", "Logs"]),
    );
    for (const hidden of ["Key Rotation", "Routing & Fallbacks", "Response Cache", "Appearance"]) {
      expect(screen.queryByRole("link", { name: hidden })).not.toBeInTheDocument();
    }
  });

  it("hides the Playground from a view-only user who otherwise has write access", () => {
    asRole("internal", { isViewOnly: true });
    renderWithProviders(<Sidebar {...defaultProps} />);

    expect(screen.queryByRole("link", { name: "Playground" })).not.toBeInTheDocument();
    expect(navLink("Virtual Keys")).toBeInTheDocument();
  });

  it("narrows an internal user's nav to an admin-saved page allowlist, but never hides the landing page", () => {
    asRole("internal");
    renderWithProviders(<Sidebar {...defaultProps} enabledPagesInternalUsers={["api-keys", "logs"]} />);

    expect(navLink("Overview")).toBeInTheDocument();
    expect(navLink("Virtual Keys")).toBeInTheDocument();
    expect(navLink("Logs")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Analytics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Models & Keys" })).not.toBeInTheDocument();
  });

  it("never narrows an admin's own nav with that allowlist", () => {
    asRole("admin");
    renderWithProviders(<Sidebar {...defaultProps} enabledPagesInternalUsers={["api-keys"]} />);

    expect(navLink("Analytics")).toBeInTheDocument();
    expect(navLink("Key Rotation")).toBeInTheDocument();
  });

  it("routes a click through setPage without letting the browser navigate", () => {
    const setPage = vi.fn();
    asRole("admin");
    renderWithProviders(<Sidebar {...defaultProps} setPage={setPage} />);

    const link = navLink("Analytics");
    expect(link).toHaveAttribute("href", "/ui/analytics");

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(setPage).toHaveBeenCalledWith("analytics");
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets a modified click open the real href in a new tab instead of hijacking it", () => {
    const setPage = vi.fn();
    asRole("admin");
    renderWithProviders(<Sidebar {...defaultProps} setPage={setPage} />);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    fireEvent(navLink("Logs"), event);

    expect(setPage).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("marks the page matching defaultSelectedKey as the active item", () => {
    asRole("admin");
    renderWithProviders(<Sidebar {...defaultProps} defaultSelectedKey="logs" />);

    expect(navLink("Logs")).toHaveAttribute("data-active", "true");
    expect(navLink("Analytics")).not.toHaveAttribute("data-active");
  });

  it("falls back to the overview when the current page is not a nav item", () => {
    asRole("admin");
    renderWithProviders(<Sidebar {...defaultProps} defaultSelectedKey="onboarding" />);

    expect(navLink("Overview")).toHaveAttribute("data-active", "true");
    expect(navLink("Virtual Keys")).not.toHaveAttribute("data-active");
  });

  it("derives a section and title breadcrumb from the nav config", () => {
    expect(getBreadcrumb("overview")).toEqual({ section: "Gateway", title: "Overview" });
    expect(getBreadcrumb("analytics")).toEqual({ section: "Insights", title: "Analytics" });
    expect(getBreadcrumb("quota")).toEqual({ section: "Gateway", title: "Key Rotation" });
    expect(getBreadcrumb("router-settings")).toEqual({ section: "Settings", title: "Routing & Fallbacks" });
  });

  it("falls back to a prettified title for a page that is not in the nav", () => {
    expect(getBreadcrumb("some_other-page")).toEqual({ section: null, title: "Some Other Page" });
  });

  it("points every nav item at a route that exists on disk", () => {
    const dashboardDir = path.join(process.cwd(), "src", "app", "(dashboard)");

    for (const item of menuGroups.flatMap((group) => group.items)) {
      const segment = MIGRATED_PAGES[item.page];
      expect(segment, `${item.label} (${item.page}) is missing from MIGRATED_PAGES`).toBeDefined();
      expect(
        existsSync(path.join(dashboardDir, segment, "page.tsx")),
        `${item.label} points at (dashboard)/${segment}, which has no page.tsx`,
      ).toBe(true);
    }
  });
});
