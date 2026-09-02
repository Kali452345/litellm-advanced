import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { GET, POST, userRole, toast } = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
  userRole: { current: "Admin" },
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), fromError: vi.fn() },
}));
vi.mock("@/lib/http/api", () => ({ fetchClient: { GET, POST } }));
vi.mock("@/lib/toast", () => ({ toast }));

vi.mock("@/app/(dashboard)/hooks/useAuthorized", () => ({
  default: () => ({ accessToken: "sk-test", userRole: userRole.current }),
}));

import ProviderKeysPanel from "./ProviderKeysPanel";

const GEMINI = {
  provider: "gemini",
  api_base: null,
  api_version: null,
  key_count: 2,
  quota_scope: null,
  quota_reset_timezone: null,
  models: [
    { model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", rpm: 5, rpd: 100 },
    { model_name: "pro", litellm_model: "gemini/gemini-2.5-pro", rpm: 2, rpd: 50 },
  ],
};

const GROQ = {
  provider: "groq",
  api_base: "https://api.groq.example.com",
  api_version: null,
  key_count: 1,
  quota_scope: "credential",
  quota_reset_timezone: null,
  models: [{ model_name: "kimi", litellm_model: "groq/moonshotai/kimi-k2", rpm: 30, rpd: 1000 }],
};

const setup = () => userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never });

const renderPanel = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderKeysPanel />
    </QueryClientProvider>,
  );
};

const openForm = async (user: ReturnType<typeof setup>, provider: string) => {
  await user.click(await screen.findByTestId(`add-provider-key-${provider}`));
  return screen.findByLabelText("API Key");
};

const created = (modelName: string, litellmModel: string) => ({
  model_name: modelName,
  litellm_model: litellmModel,
  model_id: `id-${modelName}`,
});

describe("ProviderKeysPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userRole.current = "Admin";
    GET.mockResolvedValue({ data: { profiles: [GEMINI, GROQ] } });
    POST.mockResolvedValue({
      data: {
        provider: "gemini",
        models: [created("flash", "gemini/gemini-2.5-flash"), created("pro", "gemini/gemini-2.5-pro")],
      },
    });
  });

  it("lists each provider with how many keys it already has and where its cap is counted", async () => {
    renderPanel();

    expect(await screen.findByText("gemini")).toBeInTheDocument();
    expect(screen.getByText("Varies by model")).toBeInTheDocument();
    expect(screen.getByText("30/min, 1000/day")).toBeInTheDocument();
    expect(screen.getByText("Shared across models")).toBeInTheDocument();
    expect(screen.getByText("Provider default")).toBeInTheDocument();
    expect(GET).toHaveBeenCalledWith("/provider/profiles");
  });

  it("sends only the provider and the key when the prefilled form is submitted untouched", async () => {
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "  new-key  " } });
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/provider/keys", { body: { provider: "gemini", api_key: "new-key" } }),
    );
  });

  it("sends the caps typed into the form as numbers", async () => {
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    fireEvent.change(screen.getByLabelText("Requests Per Minute"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Requests Per Day"), { target: { value: "250" } });
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/provider/keys", {
        body: { provider: "gemini", api_key: "k3", rpm: 8, rpd: 250 },
      }),
    );
  });

  it("prefills the base url the provider is already reached at, so it is not retyped", async () => {
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "groq"), { target: { value: "k2" } });

    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.groq.example.com");

    await user.click(screen.getByRole("button", { name: "Add Key" }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/provider/keys", {
        body: { provider: "groq", api_key: "k2", api_base: "https://api.groq.example.com" },
      }),
    );
  });

  it("names the models only once one of the provider's models is dropped", async () => {
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /gemini-2\.5-flash/ }));
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "Add Key" }));

    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/provider/keys", {
        body: { provider: "gemini", api_key: "k3", models: ["pro"] },
      }),
    );
  });

  it("refuses to send a key with no models left to serve", async () => {
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    expect(await screen.findByText(/Pick at least one model/)).toBeInTheDocument();
    expect(POST).not.toHaveBeenCalled();
  });

  it("refuses to send a cap that is not a whole number of requests", async () => {
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    fireEvent.change(screen.getByLabelText("Requests Per Minute"), { target: { value: "2.5" } });
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    expect(await screen.findByText(/whole number of requests/)).toBeInTheDocument();
    expect(POST).not.toHaveBeenCalled();
  });

  it("refuses to send an empty key", async () => {
    const user = setup();
    renderPanel();

    await openForm(user, "gemini");
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    expect(await screen.findByText(/Paste the key this provider issued/)).toBeInTheDocument();
    expect(POST).not.toHaveBeenCalled();
  });

  it("closes the form and reports how many models the key joined", async () => {
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Key added to 2 gemini models"));
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });

  it("names the model the provider refused instead of reporting a clean success", async () => {
    POST.mockResolvedValue({
      data: {
        provider: "gemini",
        models: [
          { model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", error: "not on this key's tier" },
          created("pro", "gemini/gemini-2.5-pro"),
        ],
      },
    });
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith("Key added to 1 of gemini's models", {
        description: "flash: not on this key's tier",
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps the form open when every model was refused", async () => {
    POST.mockResolvedValue({
      data: {
        provider: "gemini",
        models: [{ model_name: "flash", litellm_model: "gemini/gemini-2.5-flash", error: "bad key" }],
      },
    });
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("No models added to gemini", { description: "flash: bad key" }),
    );
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
  });

  it("surfaces a rejected request rather than leaving the form looking idle", async () => {
    POST.mockRejectedValue(new Error("provider not configured"));
    const user = setup();
    renderPanel();

    fireEvent.change(await openForm(user, "gemini"), { target: { value: "k3" } });
    await user.click(screen.getByRole("button", { name: "Add Key" }));

    await waitFor(() => expect(toast.fromError).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("offers an admin viewer no way to start a write the proxy would reject with a 403", async () => {
    userRole.current = "Admin Viewer";
    renderPanel();

    expect(await screen.findByTestId("add-provider-key-gemini")).toBeDisabled();
  });
});
