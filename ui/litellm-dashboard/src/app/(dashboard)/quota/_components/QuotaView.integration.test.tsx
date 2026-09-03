import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { components } from "@/lib/http/schema";

const { GET, session } = vi.hoisted(() => ({
  GET: vi.fn(),
  session: { userRole: "Admin" },
}));

vi.mock("@/lib/http/api", () => ({ fetchClient: { GET } }));
vi.mock("@/app/(dashboard)/hooks/useAuthorized", () => ({
  default: () => ({ accessToken: "sk-test", userRole: session.userRole, userId: "u-42" }),
}));

import { QUOTA_POLL_MS } from "@/app/(dashboard)/hooks/quotaUsage/useQuotaUsage";

import { QuotaView } from "./QuotaView";

type Usage = components["schemas"]["ModelQuotaUsageResponse"];
type WindowUsage = components["schemas"]["QuotaWindowUsage"];

const meter = (kind: WindowUsage["kind"], used: number, limit: number, resetIn: number): WindowUsage => ({
  kind,
  limit,
  used,
  remaining: Math.max(0, limit - used),
  seconds_until_reset: resetIn,
  timezone: kind === "rpd" ? "America/New_York" : "UTC",
});

const FLASH_POOL: Usage["pools"][number] = {
  model_name: "flash",
  exhausted: false,
  keys: [
    {
      model_id: "id-a",
      litellm_model: "gemini/gemini-2.5-flash",
      exhausted: false,
      windows: [meter("rpm", 2, 5, 34), meter("rpd", 40, 100, 7200)],
    },
    {
      model_id: "id-b",
      litellm_model: "gemini/gemini-2.5-flash",
      api_base: "https://alt.example.com",
      exhausted: true,
      seconds_until_room: 42,
      windows: [meter("rpm", 5, 5, 42)],
    },
  ],
};

const USAGE: Usage = {
  enforced: true,
  pools: [
    {
      model_name: "pro",
      exhausted: true,
      seconds_until_room: 90,
      keys: [
        {
          model_id: "id-c",
          litellm_model: "gemini/gemini-2.5-pro",
          exhausted: true,
          seconds_until_room: 90,
          windows: [meter("rpm", 2, 2, 90)],
        },
      ],
    },
    FLASH_POOL,
    {
      model_name: "kimi",
      exhausted: false,
      keys: [{ model_id: "id-d", litellm_model: "groq/moonshotai/kimi-k2", exhausted: false, windows: [] }],
    },
  ],
};

const renderView = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <QuotaView />
    </QueryClientProvider>,
  );
};

const pool = (modelName: string) => screen.getByTestId(`quota-pool-${modelName}`);
const keyRow = (modelId: string) => screen.getByTestId(`quota-key-${modelId}`);

const expectSummary = (slug: string, value: string) =>
  expect(within(screen.getByTestId(`summary-card-${slug}`)).getByText(value)).toBeInTheDocument();

describe("QuotaView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.userRole = "Admin";
    GET.mockResolvedValue({ data: USAGE });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders one card per pool, in model-name order, with how many keys still have room", async () => {
    renderView();

    await screen.findByTestId("quota-pool-flash");

    expect(screen.getAllByTestId(/^quota-pool-/).map((card) => card.dataset.testid)).toEqual([
      "quota-pool-flash",
      "quota-pool-kimi",
      "quota-pool-pro",
    ]);
    expect(within(pool("flash")).getByText("1 of 2 keys has room right now")).toBeInTheDocument();
    expect(within(pool("kimi")).getByText("1 of 1 key has room right now")).toBeInTheDocument();
    expect(GET).toHaveBeenCalledWith("/model/quota/usage");
  });

  it("says how long a fully spent pool waits before it can serve again", async () => {
    renderView();

    const spentPool = await screen.findByTestId("quota-pool-pro");

    expect(within(spentPool).getByText("Every key spent, free in 1m 30s")).toBeInTheDocument();
    expect(within(pool("flash")).getByText("Serving")).toBeInTheDocument();
  });

  it("meters a key's minute and day windows against the caps the provider issued", async () => {
    renderView();
    await screen.findByTestId("quota-key-id-a");

    const minute = within(keyRow("id-a")).getByTestId("quota-window-rpm");
    expect(minute).toHaveAttribute("aria-valuenow", "2");
    expect(minute).toHaveAttribute("aria-valuemax", "5");
    expect(within(minute).getByText("2 / 5")).toBeInTheDocument();
    expect(within(minute).getByText("resets in 34s")).toBeInTheDocument();

    const day = within(keyRow("id-a")).getByTestId("quota-window-rpd");
    expect(within(day).getByText("40 / 100")).toBeInTheDocument();
    expect(within(day).getByText("resets in 2h")).toBeInTheDocument();
  });

  it("marks the key routing has to skip, and when the router gets it back", async () => {
    renderView();
    await screen.findByTestId("quota-key-id-b");

    expect(within(keyRow("id-b")).getByText("Spent, free in 42s")).toBeInTheDocument();
    expect(within(keyRow("id-b")).getByText("free in 42s")).toBeInTheDocument();
    expect(within(keyRow("id-a")).getByText("Available")).toBeInTheDocument();
  });

  it("tells two keys on the same model apart by the base url each is reached at", async () => {
    renderView();
    await screen.findByTestId("quota-key-id-b");

    expect(within(keyRow("id-b")).getByText("https://alt.example.com")).toBeInTheDocument();
    expect(within(keyRow("id-a")).getByText("gemini")).toBeInTheDocument();
  });

  it("says an uncapped key is used without a quota check rather than metering it", async () => {
    renderView();
    await screen.findByTestId("quota-key-id-d");

    const uncapped = within(keyRow("id-d"));
    expect(uncapped.getByText(/No per-minute or per-day cap set/)).toBeInTheDocument();
    expect(uncapped.queryByTestId("quota-window-rpm")).not.toBeInTheDocument();
  });

  it("counts the pools, the keys with room, the spent pools and the uncapped keys", async () => {
    renderView();
    await screen.findByTestId("quota-pool-flash");

    expectSummary("pools", "3");
    expectSummary("keys-with-room", "2 / 4");
    expectSummary("pools-fully-spent", "1");
    expectSummary("keys-without-a-cap", "1");
  });

  it("reports that nothing counts against the caps when quota routing is off", async () => {
    GET.mockResolvedValue({ data: { ...USAGE, enforced: false } });
    renderView();

    expect(await screen.findByText("Quota not enforced")).toBeInTheDocument();
    expect(screen.queryByText("Quota enforced")).not.toBeInTheDocument();
  });

  it("shows a spent key getting its room back without the operator reloading", async () => {
    vi.useFakeTimers();
    const roomAgain = {
      ...FLASH_POOL.keys[1],
      exhausted: false,
      seconds_until_room: null,
      windows: [meter("rpm", 0, 5, 60)],
    };
    const recovered: Usage = {
      ...USAGE,
      pools: USAGE.pools.map((candidate) =>
        candidate.model_name === "flash" ? { ...FLASH_POOL, keys: [FLASH_POOL.keys[0], roomAgain] } : candidate,
      ),
    };
    renderView();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(within(keyRow("id-b")).getByText("Spent, free in 42s")).toBeInTheDocument();

    GET.mockResolvedValue({ data: recovered });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUOTA_POLL_MS);
    });

    expect(within(keyRow("id-b")).getByText("Available")).toBeInTheDocument();
    expect(within(pool("flash")).getByText("2 of 2 keys has room right now")).toBeInTheDocument();
  });

  it("offers a non-admin no quota data and does not ask the proxy for any", async () => {
    session.userRole = "Internal User";
    renderView();

    expect(await screen.findByText("Key Rotation is only available to admin users.")).toBeInTheDocument();
    expect(screen.queryByTestId("summary-card-pools")).not.toBeInTheDocument();
    expect(GET).not.toHaveBeenCalled();
  });

  it("points an operator with no pools at where a second key gets added", async () => {
    GET.mockResolvedValue({ data: { enforced: true, pools: [] } });
    renderView();

    expect(await screen.findByText(/No model has more than one key behind it yet/)).toBeInTheDocument();
    expectSummary("pools", "0");
  });
});
