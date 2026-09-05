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
type Observed = components["schemas"]["ObservedRateLimitsResponse"];
type ObservedWindow = components["schemas"]["ObservedWindow"];

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

const observedWindow = (kind: ObservedWindow["kind"], allowed: number, configuredThen: number): ObservedWindow => ({
  kind,
  configured_limit: configuredThen,
  refusals: 2,
  lowest_count_at_refusal: allowed + 1,
  highest_count_at_refusal: allowed + 3,
  suggested_limit: allowed,
});

const NOTHING_OBSERVED: Observed = {
  since: "2026-09-04T12:00:00Z",
  refusals_read: 0,
  unmetered_refusals: 0,
  keys: [],
};

const refused = (): Observed => ({
  since: "2026-09-04T12:00:00Z",
  refusals_read: 9,
  unmetered_refusals: 2,
  keys: [
    {
      model_id: "id-a",
      model_group: "flash",
      litellm_model_name: "gemini-2.5-flash",
      api_base: "https://generativelanguage.googleapis.com",
      refusals: 4,
      last_refusal: new Date(Date.now() - 3_600_000).toISOString(),
      longest_retry_after_seconds: 41,
      windows: [observedWindow("rpm", 3, 50), observedWindow("rpd", 80, 100)],
    },
  ],
});

const respond = (usage: Usage, observed: Observed = NOTHING_OBSERVED) =>
  GET.mockImplementation((path: string) =>
    Promise.resolve({ data: path === "/provider/rate_limit/observed" ? observed : usage }),
  );

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
    respond(USAGE);
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

  it("names what a provider really allowed under the key it refused, against the cap in force now", async () => {
    respond(USAGE, refused());
    renderView();

    await screen.findByTestId("observed-limits-id-a");
    const note = within(keyRow("id-a")).getByTestId("observed-limits-id-a");

    expect(within(note).getByText("4 refusals, last 1h ago, longest wait asked for 41s")).toBeInTheDocument();
    expect(within(note).getByTestId("observed-rpm")).toHaveTextContent(
      "Allowed 3, so Requests Per Minute is 2 too high",
    );
    expect(within(note).getByTestId("observed-rpd")).toHaveTextContent(
      "Allowed 80, so Requests Per Day is 20 too high",
    );
    expect(GET).toHaveBeenCalledWith("/provider/rate_limit/observed", { params: { query: { hours: 24 } } });
  });

  it("leaves a key no provider has refused without a note claiming otherwise", async () => {
    respond(USAGE, refused());
    renderView();

    await screen.findByTestId("observed-limits-id-a");

    expect(screen.queryByTestId("observed-limits-id-b")).not.toBeInTheDocument();
    expect(within(keyRow("id-b")).getByText("Spent, free in 42s")).toBeInTheDocument();
  });

  it("counts every cap sitting above what a provider proved it allows, and how much measured it", async () => {
    respond(USAGE, refused());
    renderView();

    await screen.findByTestId("observed-limits-id-a");

    expectSummary("caps-set-too-high", "2");
    expectSummary("caps-set-too-high", "Measured from 7 of 9 refusals");
  });

  it("says no refusal has been logged rather than that every cap is right", async () => {
    renderView();
    await screen.findByTestId("quota-pool-flash");

    expectSummary("caps-set-too-high", "0");
    expectSummary("caps-set-too-high", "No rate limit refusal logged in the last 24h");
    expect(screen.queryAllByTestId(/^observed-limits-/)).toHaveLength(0);
  });

  it("reports that nothing counts against the caps when quota routing is off", async () => {
    respond({ ...USAGE, enforced: false });
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

    respond(recovered);
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
    respond({ enforced: true, max_wait_seconds: 75, pools: [] });
    renderView();

    expect(await screen.findByText(/Add one under Provider Keys/)).toBeInTheDocument();
    expectSummary("pools", "0");
  });

  it("turns rotation on from the page, sending the hold budget with the flag", async () => {
    respond({ ...USAGE, enforced: false });
    const user = setup();
    renderView();

    await screen.findByText("Quota not enforced");
    await user.click(enforceSwitch());
    fireEvent.change(holdField(), { target: { value: "30" } });
    respond({ ...USAGE, enforced: true, max_wait_seconds: 30 });
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
