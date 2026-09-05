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

import { AnalyticsView } from "./AnalyticsView";

type Metrics = components["schemas"]["SpendMetrics"];
type Day = components["schemas"]["DailySpendData"];

const AGGREGATED = "/user/daily/activity/aggregated";
const PAGED = "/user/daily/activity";

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

const cached = (metrics: Metrics, read: number, write: number): Metrics => ({
  ...metrics,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});

const DAY_ONE_TOTAL = cached(spent(120, 20, [8000, 2000], 1.5), 2620, 500);

const DAY_ONE: Day = {
  date: "2026-08-30",
  metrics: DAY_ONE_TOTAL,
  breakdown: {
    models: {
      "gemini-2.5-flash": { metrics: spent(100, 10, [7000, 1800], 1.2) },
      "gemini-2.5-pro": { metrics: spent(20, 10, [1000, 200], 0.3) },
    },
    providers: { gemini: { metrics: DAY_ONE_TOTAL } },
    api_keys: {
      "harness-a-hash": { metrics: spent(90, 15, [6000, 1500], 1.1), metadata: { key_alias: "harness-a" } },
      "0011223344556677aabb": { metrics: spent(30, 5, [2000, 500], 0.4) },
    },
    endpoints: {
      "/v1/chat/completions": { metrics: spent(100, 15, [7000, 1700], 1.25) },
      "/v1/messages": { metrics: spent(20, 5, [1000, 300], 0.25) },
    },
  },
};

const DAY_TWO_TOTAL = spent(80, 10, [2480, 560], 0.75);

const DAY_TWO: Day = {
  date: "2026-08-31",
  metrics: DAY_TWO_TOTAL,
  breakdown: {
    models: {
      "gemini-2.5-flash": { metrics: spent(70, 8, [2000, 400], 0.55) },
      "gemini-2.5-pro": { metrics: spent(10, 2, [480, 160], 0.2) },
    },
    providers: { gemini: { metrics: DAY_TWO_TOTAL } },
    api_keys: {
      "harness-a-hash": { metrics: spent(60, 7, [1800, 400], 0.5), metadata: { key_alias: "harness-a" } },
      "0011223344556677aabb": { metrics: spent(20, 3, [680, 160], 0.25) },
    },
    endpoints: { "/v1/chat/completions": { metrics: DAY_TWO_TOTAL } },
  },
};

type WireQuery = {
  start_date: string;
  end_date: string;
  include_current_utc_day: boolean;
  user_id: string | null;
  api_key: string | null;
  page?: number;
};

const queriesFor = (path: string): WireQuery[] =>
  GET.mock.calls
    .filter((call) => call[0] === path)
    .map((call) => (call[1] as { params: { query: WireQuery } }).params.query);

const lastQuery = (path: string): WireQuery | undefined => queriesFor(path).at(-1);

const renderView = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AnalyticsView />
    </QueryClientProvider>,
  );
};

const setupUser = () => userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

const tab = (list: string, name: string) =>
  within(screen.getByRole("tablist", { name: list })).getByRole("tab", { name });

const cellsOf = (name: RegExp) =>
  within(screen.getByRole("row", { name }))
    .getAllByRole("cell")
    .map((cell) => cell.textContent);

const bodyNames = (): string[] =>
  screen
    .getAllByRole("row")
    .map((entry) => within(entry).queryAllByRole("cell")[0]?.textContent ?? "")
    .filter((name) => name !== "");

const openDatePicker = async (user: ReturnType<typeof setupUser>) => {
  const trigger = document.querySelector<HTMLElement>('[data-slot="advanced-date-picker-trigger"]');
  if (!trigger) throw new Error("the date picker did not render a trigger");
  await user.click(trigger);
};

const card = (slug: string) => screen.getByTestId(`summary-card-${slug}`);

describe("AnalyticsView", () => {
  beforeAll(() => {
    if (typeof window.requestIdleCallback === "function") return;
    window.requestIdleCallback = (callback: IdleRequestCallback): number =>
      window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    session.userRole = "Admin";
    // Only Date is faked: the range the view asks for is derived from the clock, while
    // user-event and react-query keep the real timers they poll on.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-02T12:00:00Z") });
    GET.mockResolvedValue({ data: { results: [DAY_ONE, DAY_TWO] } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the aggregated endpoint for the last seven days and scopes an admin to nothing", async () => {
    const lastSevenDays = {
      start_date: "2026-08-26",
      end_date: "2026-09-02",
      include_current_utc_day: true,
      user_id: null,
      api_key: null,
    };
    renderView();

    expect(await screen.findByRole("row", { name: /^gemini-2\.5-flash/ })).toBeInTheDocument();
    expect(lastQuery(AGGREGATED)).toMatchObject(lastSevenDays);
    expect(queriesFor(PAGED)).toHaveLength(0);
  });

  it("adds every day in the range up into the headline figures", async () => {
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    expect(within(card("requests")).getByText("200")).toBeInTheDocument();
    expect(within(card("requests")).getByText("170 succeeded, 30 failed")).toBeInTheDocument();
    expect(within(card("failure-rate")).getByText("15%")).toBeInTheDocument();
    expect(within(card("failure-rate")).getByText("30")).toBeInTheDocument();
    expect(within(card("total-tokens")).getByText("13K")).toBeInTheDocument();
    expect(within(card("total-tokens")).getByText("10.5K in, 2,560 out")).toBeInTheDocument();
    expect(within(card("tokens-per-request")).getByText("76.7")).toBeInTheDocument();
    expect(within(card("tokens-per-request")).getByText("61.6 in, 15.1 out")).toBeInTheDocument();
    expect(within(card("spend")).getByText("$2.25")).toBeInTheDocument();
    expect(within(card("spend")).getByText("$0.0132 per successful request")).toBeInTheDocument();
  });

  it("separates tokens the provider cache served from tokens written into it", async () => {
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    expect(within(card("cache-hit-rate")).getByText("20%")).toBeInTheDocument();
    expect(within(card("cache-hit-rate")).getByText("2,620")).toBeInTheDocument();
    expect(within(card("cache-writes")).getByText("500")).toBeInTheDocument();
    expect(within(card("prompt-/-completion")).getByText("10,480")).toBeInTheDocument();
    expect(within(card("prompt-/-completion")).getByText("2,560")).toBeInTheDocument();
  });

  it("folds a model's days into one row and puts the busiest model first", async () => {
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    expect(cellsOf(/^gemini-2\.5-flash/)).toEqual([
      "gemini-2.5-flash",
      "170",
      "18",
      "10.6%",
      "11.2K",
      "9,000",
      "2,200",
      "73.7",
      "$1.75",
    ]);
    expect(cellsOf(/^gemini-2\.5-pro/)).toEqual([
      "gemini-2.5-pro",
      "30",
      "12",
      "40%",
      "1,840",
      "1,480",
      "360",
      "102.2",
      "$0.5000",
    ]);
    expect(bodyNames()).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
  });

  it.each([
    ["Models", "Model", /^gemini-2\.5-flash 170/],
    ["Providers", "Provider", /^gemini 200/],
    ["API keys", "Key", /^harness-a 150/],
    ["Endpoints", "Endpoint", /^\/v1\/chat\/completions 180/],
  ] as const)("breaks the same range down by %s", async (label, nameTitle, firstRow) => {
    const user = setupUser();
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    await user.click(tab("Breakdown", label));

    expect(await screen.findByRole("row", { name: firstRow })).toBeInTheDocument();
    expect(
      screen.getByText(`Every ${nameTitle.toLowerCase()} that served a request in this range`),
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: nameTitle })).toBeInTheDocument();
  });

  it("re-ranks the top-N chart when the operator ranks by tokens instead of requests", async () => {
    const user = setupUser();
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    expect(screen.getByText("Top 2 by requests")).toBeInTheDocument();

    await user.click(tab("Rank by", "Tokens"));

    expect(await screen.findByText("Top 2 by tokens")).toBeInTheDocument();
    expect(screen.queryByText("Top 2 by requests")).not.toBeInTheDocument();
  });

  it("switches the daily trend from request counts to the failure rate", async () => {
    const user = setupUser();
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    expect(screen.getByText("Requests per day, split by whether the proxy completed them")).toBeInTheDocument();

    await user.click(tab("Metric", "Failure rate"));

    expect(await screen.findByText("Share of settled requests that failed, day by day")).toBeInTheDocument();
    expect(screen.queryByText("Requests per day, split by whether the proxy completed them")).not.toBeInTheDocument();
  });

  it("narrows the range the proxy is asked about to a single day", async () => {
    const user = setupUser();
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    await openDatePicker(user);
    await user.click(screen.getByRole("button", { name: /^Today/ }));
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(lastQuery(AGGREGATED)).toMatchObject({ start_date: "2026-09-02", end_date: "2026-09-02" }),
    );
  });

  it("names a key by its alias and shortens the hash of one that has none", async () => {
    const user = setupUser();
    renderView();
    await screen.findByRole("row", { name: /^gemini-2\.5-flash/ });

    await user.click(tab("Breakdown", "API keys"));

    expect(await screen.findByRole("row", { name: /^harness-a 150/ })).toBeInTheDocument();
    expect(cellsOf(/^0011223344\.\.\./)).toEqual([
      "0011223344...",
      "50",
      "8",
      "16%",
      "3,340",
      "2,680",
      "660",
      "79.5",
      "$0.6500",
    ]);
    expect(screen.queryByRole("row", { name: /harness-a-hash/ })).not.toBeInTheDocument();
  });

  it("falls back to walking pages when the aggregated route cannot answer", async () => {
    GET.mockImplementation((path: string, init: { params: { query: WireQuery } }) => {
      if (path === AGGREGATED) return Promise.resolve({ error: { detail: "aggregation unavailable" } });
      return Promise.resolve(
        init.params.query.page === 1
          ? { data: { results: [DAY_ONE], metadata: { has_more: true } } }
          : { data: { results: [DAY_TWO], metadata: { has_more: false } } },
      );
    });
    renderView();

    expect(await screen.findByRole("row", { name: /^gemini-2\.5-flash/ })).toBeInTheDocument();
    expect(within(card("requests")).getByText("200")).toBeInTheDocument();
    expect(queriesFor(PAGED).map((query) => query.page)).toEqual([1, 2]);
  });

  it("scopes a non-admin to their own spend instead of the whole proxy", async () => {
    session.userRole = "Internal User";
    renderView();

    expect(await screen.findByRole("row", { name: /^gemini-2\.5-flash/ })).toBeInTheDocument();
    expect(lastQuery(AGGREGATED)).toMatchObject({ user_id: "u-42" });
  });

  it("says the range recorded nothing rather than drawing an empty chart", async () => {
    GET.mockResolvedValue({ data: { results: [] } });
    renderView();

    expect(await screen.findByText("No model served a request in this range.")).toBeInTheDocument();
    expect(within(card("requests")).getByText("0")).toBeInTheDocument();
    expect(within(card("spend")).getByText("$0.00")).toBeInTheDocument();
    expect(screen.getByText("No data")).toBeInTheDocument();
  });
});
