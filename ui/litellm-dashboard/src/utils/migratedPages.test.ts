import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const withRootPath = async (serverRootPath: string) => {
  vi.doMock("@/components/networking", () => ({ serverRootPath }));
  return import("./migratedPages");
};

describe("migratedHref / legacyPageHref", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds a /ui-rooted path when serverRootPath is /", async () => {
    const { migratedHref, legacyPageHref } = await withRootPath("/");

    expect(migratedHref("analytics")).toBe("/ui/analytics");
    expect(legacyPageHref("some-legacy-page")).toBe("/ui/?page=some-legacy-page");
  });

  it("prefixes a non-root serverRootPath without duplicating slashes", async () => {
    const { migratedHref, legacyPageHref } = await withRootPath("/team-x/");

    expect(migratedHref("analytics")).toBe("/team-x/ui/analytics");
    expect(legacyPageHref("some-legacy-page")).toBe("/team-x/ui/?page=some-legacy-page");
  });

  it("tolerates a leading slash in the route segment", async () => {
    const { migratedHref } = await withRootPath("/");

    expect(migratedHref("/analytics")).toBe("/ui/analytics");
  });

  it("maps every sidebar id that was renamed on the way to its route", async () => {
    const { MIGRATED_PAGES, migratedHref } = await withRootPath("/");

    expect(MIGRATED_PAGES.models).toBe("models-and-endpoints");
    expect(MIGRATED_PAGES["llm-playground"]).toBe("playground");
    expect(migratedHref(MIGRATED_PAGES.models)).toBe("/ui/models-and-endpoints");
    expect(migratedHref(MIGRATED_PAGES["llm-playground"])).toBe("/ui/playground");
  });

  it("covers exactly the trimmed page set, so a removed page cannot keep a live route", async () => {
    const { MIGRATED_PAGES } = await withRootPath("/");

    expect(Object.keys(MIGRATED_PAGES).sort()).toEqual([
      "analytics",
      "api-keys",
      "caching",
      "llm-playground",
      "logs",
      "models",
      "quota",
      "router-settings",
      "ui-theme",
    ]);
  });
});

describe("dev server (NODE_ENV=development)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds root-relative hrefs because next dev serves the app at /, not /ui", async () => {
    const { migratedHref, legacyPageHref } = await withRootPath("/");

    expect(migratedHref("analytics")).toBe("/analytics");
    expect(legacyPageHref("some-legacy-page")).toBe("/?page=some-legacy-page");
  });

  it("ignores serverRootPath, which only applies to proxy-mounted deployments", async () => {
    const { migratedHref } = await withRootPath("/team-x/");

    expect(migratedHref("analytics")).toBe("/analytics");
  });

  it("maps a bare migrated path back to its legacy sidebar key", async () => {
    const { legacyKeyForPathname } = await withRootPath("/");

    expect(legacyKeyForPathname("/models-and-endpoints/")).toBe("models");
    expect(legacyKeyForPathname("/")).toBeNull();
  });
});

describe("legacyKeyForPathname", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps a migrated path back to its legacy sidebar key (including trailing slash)", async () => {
    const { legacyKeyForPathname } = await withRootPath("/");

    expect(legacyKeyForPathname("/ui/models-and-endpoints")).toBe("models");
    expect(legacyKeyForPathname("/ui/models-and-endpoints/")).toBe("models");
    expect(legacyKeyForPathname("/ui/playground")).toBe("llm-playground");
  });

  it("round-trips every migrated page, so the sidebar highlights the route the user is on", async () => {
    const { MIGRATED_PAGES, migratedHref, legacyKeyForPathname } = await withRootPath("/");

    for (const [key, segment] of Object.entries(MIGRATED_PAGES)) {
      expect(legacyKeyForPathname(migratedHref(segment)), `${key} does not round-trip`).toBe(key);
    }
  });

  it("returns null for a not-yet-migrated path", async () => {
    const { legacyKeyForPathname } = await withRootPath("/");

    expect(legacyKeyForPathname("/ui/")).toBeNull();
    expect(legacyKeyForPathname("/ui/some-legacy-page")).toBeNull();
  });

  it("strips a non-root serverRootPath prefix before matching", async () => {
    const { legacyKeyForPathname } = await withRootPath("/team-x/");

    expect(legacyKeyForPathname("/team-x/ui/analytics")).toBe("analytics");
    expect(legacyKeyForPathname("/ui/analytics")).toBeNull();
  });
});
