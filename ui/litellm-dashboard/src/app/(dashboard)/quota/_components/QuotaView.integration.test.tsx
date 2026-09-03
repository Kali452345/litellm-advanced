import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { components } from "@/lib/http/schema";

const { GET, POST, session, toast } = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  session: { userRole: "Admin" },
  toast: { success: vi.fn(), fromError: vi.fn() },
}));

vi.mock("@/lib/http/api", () => ({ fetchClient: { GET, POST } }));
vi.mock("@/lib/toast", () => ({ toast }));
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
  max_wait_seconds: 75,
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

const setup = () => userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

const enforceSwitch = () => screen.getByRole("switch", { name: "Enforce per-key quotas" });
const holdField = () => screen.getByLabelText("Hold budget (seconds)");
const saveButton = () => screen.getByRole("button", { name: "Save" });

const pool = (modelName: string) => screen.getByTestId(`quota-pool-${modelName}`);
const keyRow = (modelId: string) => screen.getByTestId(`quota-key-${modelId}`);

const expectSummary = (slug: string, value: string) =>
  expect(within(screen.getByTestId(`summary-card-${slug}`)).getByText(value)).toBeInTheDocument();

describe("QuotaView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.userRole = "Admin";
    GET.mockResolvedValue({ data: USAGE });
    POST.mockResolvedValue({ data: {} });
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

  it("points an operator with no pools at where a key gets added", async () => {
    GET.mockResolvedValue({ data: { enforced: true, max_wait_seconds: 75, pools: [] } });
    renderView();

    expect(await screen.findByText(/Add one under Provider Keys/)).toBeInTheDocument();
    expectSummary("pools", "0");
  });

  it("turns rotation on from the page, sending the hold budget with the flag", async () => {
    GET.mockResolvedValue({ data: { ...USAGE, enforced: false } });
    const user = setup();
    renderView();

    await screen.findByText("Quota not enforced");
    await user.click(enforceSwitch());
    fireEvent.change(holdField(), { target: { value: "30" } });
    GET.mockResolvedValue({ data: { ...USAGE, enforced: true, max_wait_seconds: 30 } });
    await user.click(saveButton());

    expect(POST).toHaveBeenCalledWith("/config/update", {
      body: { router_settings: { enable_quota_routing: true, quota_max_wait_seconds: 30 } },
    });
    expect(await screen.findByText("Quota enforced")).toBeInTheDocument();
    expect(holdField()).toHaveValue("30");
  });

  it("saves a new hold budget while enforcement stays on", async () => {
    const user = setup();
    renderView();

    await screen.findByDisplayValue("75");
    fireEvent.change(holdField(), { target: { value: "12.5" } });
    await user.click(saveButton());

    expect(POST).toHaveBeenCalledWith("/config/update", {
      body: { router_settings: { enable_quota_routing: true, quota_max_wait_seconds: 12.5 } },
    });
    expect(toast.success).toHaveBeenCalledWith("Quota routing on, holding a spent request up to 12.5s");
  });

  it("keeps the running budget when enforcement is turned off", async () => {
    const user = setup();
    renderView();

    await screen.findByDisplayValue("75");
    await user.click(enforceSwitch());

    expect(holdField()).toBeDisabled();
    await user.click(saveButton());

    expect(POST).toHaveBeenCalledWith("/config/update", {
      body: { router_settings: { enable_quota_routing: false, quota_max_wait_seconds: 75 } },
    });
  });

  it("offers no save until something changes, and refuses a budget that is not a count of seconds", async () => {
    renderView();

    await screen.findByDisplayValue("75");
    expect(saveButton()).toBeDisabled();

    fireEvent.change(holdField(), { target: { value: "a minute" } });

    expect(screen.getByText("Seconds only, like 75 or 12.5.")).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(POST).not.toHaveBeenCalled();
  });

  it("tells the operator when the save was rejected instead of pretending it landed", async () => {
    POST.mockRejectedValue(new Error("403 Forbidden"));
    const user = setup();
    renderView();

    await screen.findByDisplayValue("75");
    fireEvent.change(holdField(), { target: { value: "20" } });
    await user.click(saveButton());

    expect(toast.fromError).toHaveBeenCalled();
    expect(holdField()).toHaveValue("20");
  });
});
