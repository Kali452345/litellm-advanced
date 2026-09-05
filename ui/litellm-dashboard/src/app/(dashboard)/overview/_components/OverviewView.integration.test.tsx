import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { components } from "@/lib/http/schema";

const { GET, session } = vi.hoisted(() => ({
  GET: vi.fn(),
  session: { userRole: "Admin" },
}));

vi.mock("@/lib/http/api", () => ({ fetchClient: { GET } }));
vi.mock("@/app/(dashboard)/hooks/useAuthorized", () => ({
  default: () => ({ accessToken: "sk-test", userRole: session.userRole, userId: "u-42" }),
}));

import { OverviewView } from "./OverviewView";

type Metrics = components["schemas"]["SpendMetrics"];
type Day = components["schemas"]["DailySpendData"];
type Usage = components["schemas"]["ModelQuotaUsageResponse"];
type WindowUsage = components["schemas"]["QuotaWindowUsage"];

const AGGREGATED = "/user/daily/activity/aggregated";
const QUOTA = "/model/quota/usage";

const ZERO: Metrics = {
  spend: 0,
  flat_cost: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  api_requests: 0,
  successful_requests: 0,
  failed_requests: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  compression_saved_tokens: 0,
  compression_savings_spend: 0,
  prompt_caching_savings_spend: 0,
  gateway_injected_caching_savings_spend: 0,
  autorouter_savings_spend: 0,
};

const spent = (requests: number, failed: number, tokens: [number, number], cost: number): Metrics => ({
  ...ZERO,
  api_requests: requests,
  successful_requests: requests - failed,
  failed_requests: failed,
  prompt_tokens: tokens[0],
  completion_tokens: tokens[1],
  total_tokens: tokens[0] + tokens[1],
  spend: cost,
});

const DAY_ONE: Day = {
  date: "2026-08-30",
  metrics: spent(120, 20, [8000, 2000], 1.5),
  breakdown: {
    models: {
      flash: { metrics: spent(100, 10, [7000, 1800], 1.2) },
      pro: { metrics: spent(20, 10, [1000, 200], 0.3) },
    },
  },
};

const DAY_TWO: Day = {
  date: "2026-08-31",
  metrics: spent(80, 10, [2480, 560], 0.75),
  breakdown: {
    models: {
      flash: { metrics: spent(70, 8, [2000, 400], 0.55) },
      pro: { metrics: spent(10, 2, [480, 160], 0.2) },
    },
  },
};

const meter = (kind: WindowUsage["kind"], used: number, limit: number, resetIn: number): WindowUsage => ({
  kind,
  limit,
  used,
  remaining: Math.max(0, limit - used),
  seconds_until_reset: resetIn,
  timezone: "UTC",
});

const USAGE: Usage = {
  enforced: true,
  max_wait_seconds: 75,
  pools: [
    {
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
          exhausted: true,
          seconds_until_room: 42,
          windows: [meter("rpm", 5, 5, 42)],
        },
      ],
    },
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
    {
      model_name: "kimi",
      exhausted: false,
      keys: [{ model_id: "id-d", litellm_model: "groq/moonshotai/kimi-k2", exhausted: false, windows: [] }],
    },
  ],
};

type WireQuery = { start_date: string; end_date: string; user_id: string | null };

const served = { days: [DAY_ONE, DAY_TWO] as Day[], usage: USAGE as Usage };

const respond = (path: string) => {
  if (path === QUOTA) return Promise.resolve({ data: served.usage });
  if (path === AGGREGATED) return Promise.resolve({ data: { results: served.days } });
  return Promise.resolve({ data: { results: [] } });
};

const renderView = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <OverviewView />
    </QueryClientProvider>,
  );
};

const setupUser = () => userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

const tab = (list: string, name: string) =>
  within(screen.getByRole("tablist", { name: list })).getByRole("tab", { name });

const card = (slug: string) => screen.getByTestId(`summary-card-${slug}`);

// A Base UI meter root carries a visually hidden filler node, so the quota cell's own
// textContent is not the percentage an operator reads off the row.
const PERCENT = /^\d+(\.\d+)?%$/;

const poolRow = (modelName: string): (string | null)[] => {
  const [name, room, quota, status] = within(screen.getByTestId(`overview-pool-${modelName}`)).getAllByRole("cell");
  return [name.textContent, room.textContent, within(quota).getByText(PERCENT).textContent, status.textContent];
};

const alertTitles = (): string[] =>
  screen.getAllByRole("alert").map((alert) => alert.querySelector("[data-slot='alert-title']")?.textContent ?? "");

const callsTo = (path: string) => GET.mock.calls.filter((call) => call[0] === path);

const lastQuery = (path: string): WireQuery | undefined =>
  callsTo(path)
    .map((call) => (call[1] as { params: { query: WireQuery } }).params.query)
    .at(-1);

const poolNames = (): string[] =>
  screen.getAllByTestId(/^overview-pool-/).map((row) => within(row).getAllByRole("cell")[0].textContent ?? "");

describe("OverviewView", () => {
  beforeAll(() => {
    if (typeof window.requestIdleCallback === "function") return;
    window.requestIdleCallback = (callback: IdleRequestCallback): number =>
      window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    session.userRole = "Admin";
    served.days = [DAY_ONE, DAY_TWO];
    served.usage = USAGE;
    // Only Date is faked: the range the view asks for is derived from the clock, while
    // user-event and react-query keep the real timers they poll on.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-02T12:00:00Z") });
    GET.mockImplementation(respond);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the seven days ending today and adds them into the headline figures", async () => {
    renderView();

    expect(await screen.findByTestId("overview-model-flash")).toBeInTheDocument();
    expect(lastQuery(AGGREGATED)).toMatchObject({
      start_date: "2026-08-27",
      end_date: "2026-09-02",
      user_id: null,
    });
    expect(within(card("requests")).getByText("200")).toBeInTheDocument();
    expect(within(card("requests")).getByText("170 succeeded, 30 failed")).toBeInTheDocument();
    expect(within(card("failed-requests")).getByText("30")).toBeInTheDocument();
    expect(within(card("failed-requests")).getByText("15%")).toBeInTheDocument();
    expect(within(card("total-tokens")).getByText("13K")).toBeInTheDocument();
    expect(within(card("total-tokens")).getByText("10.5K in, 2,560 out")).toBeInTheDocument();
    expect(within(card("tokens-per-request")).getByText("76.7")).toBeInTheDocument();
    expect(within(card("tokens-per-request")).getByText("$0.0132 per successful request")).toBeInTheDocument();
  });

  it("ranks the models by share of requests and prices each one", async () => {
    renderView();

    const flash = await screen.findByTestId("overview-model-flash");
    expect(within(flash).getByText("85%")).toBeInTheDocument();
    expect(within(flash).getByText("170 requests, 73.7 tokens each, 10.6% failed, $1.75")).toBeInTheDocument();

    const pro = screen.getByTestId("overview-model-pro");
    expect(within(pro).getByText("15%")).toBeInTheDocument();
    expect(within(pro).getByText("30 requests, 102.2 tokens each, 40% failed, $0.5000")).toBeInTheDocument();
  });

  it("orders the key pools by what needs a human and counts the keys still holding room", async () => {
    renderView();

    expect(await screen.findByTestId("overview-pool-flash")).toBeInTheDocument();
    expect(poolNames()).toEqual(["pro", "kimi", "flash"]);
    expect(poolRow("pro")).toEqual(["pro", "0 of 1", "100%", "Free in 1m 30s"]);
    expect(poolRow("kimi")).toEqual(["kimi", "1 of 1", "0%", "Single key"]);
    expect(poolRow("flash")).toEqual(["flash", "1 of 2", "70%", "Serving"]);
  });

  it("leads the attention list with the pool that has nothing left to route to", async () => {
    renderView();

    expect(await screen.findByTestId("overview-pool-flash")).toBeInTheDocument();
    expect(alertTitles()).toEqual([
      "pro has no key with room",
      "kimi has nothing to fail over to",
      "15% of requests failed",
      "pro is failing 40% of the time",
    ]);

    const spent = screen.getAllByRole("alert")[0];
    expect(spent).toHaveTextContent(
      "Only one key sits behind pro and its quota is spent, so requests fail until room frees up in 1m 30s.",
    );
    expect(within(spent).getByRole("link", { name: "Open Key Rotation" })).toHaveAttribute("href", "/ui/quota");
  });

  it("switches the traffic chart from request counts to tokens", async () => {
    const user = setupUser();
    renderView();

    expect(await screen.findByTestId("overview-pool-flash")).toBeInTheDocument();
    expect(screen.getByText("Requests per day, split by whether the proxy completed them")).toBeInTheDocument();

    await user.click(tab("Traffic metric", "Tokens"));

    expect(await screen.findByText("Input, output and cache-read tokens per day")).toBeInTheDocument();
    expect(screen.queryByText("Requests per day, split by whether the proxy completed them")).not.toBeInTheDocument();
  });

  it("narrows the range it asks the proxy about down to today", async () => {
    const user = setupUser();
    renderView();

    expect(await screen.findByTestId("overview-pool-flash")).toBeInTheDocument();

    await user.click(tab("Range", "Today"));

    await waitFor(() =>
      expect(lastQuery(AGGREGATED)).toMatchObject({ start_date: "2026-09-02", end_date: "2026-09-02" }),
    );
  });

  it("scopes a non-admin to their own usage and never asks for the key pools", async () => {
    session.userRole = "Internal User";
    renderView();

    expect(await screen.findByTestId("overview-model-flash")).toBeInTheDocument();
    expect(lastQuery(AGGREGATED)).toMatchObject({ user_id: "u-42" });
    expect(callsTo(QUOTA)).toHaveLength(0);
    expect(screen.queryByText("Key rotation")).not.toBeInTheDocument();
  });

  it("says the range recorded nothing rather than drawing an empty ranking", async () => {
    served.days = [];
    served.usage = { enforced: false, max_wait_seconds: 75, pools: [] };
    renderView();

    expect(await screen.findByText("No model served a request in this range.")).toBeInTheDocument();
    expect(
      screen.getByText("Every pool has a key with room and nothing is failing often enough to call out."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No model is set up yet. Add one under Models & Keys and every key behind it shows up here."),
    ).toBeInTheDocument();
    expect(within(card("requests")).getByText("0")).toBeInTheDocument();
  });
});
