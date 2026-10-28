import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MountedFormHost } from "../../../tests/mounted-form-host";
import AdvancedSettings from "./advanced_settings";

const mockUsePtuCostAttributionEnabled = vi.fn();

vi.mock("@/app/(dashboard)/hooks/uiSettings/usePtuCostAttributionEnabled", () => ({
  usePtuCostAttributionEnabled: () => mockUsePtuCostAttributionEnabled(),
}));

const PTU_LABELS = ["PTU Count", "Calculated Cost per PTU / Hour (USD)", "PTU Effective From (UTC)"];

const renderAdvancedSettings = () =>
  render(
    <MountedFormHost>
      <AdvancedSettings
        showAdvancedSettings={true}
        setShowAdvancedSettings={() => {}}
        guardrailsList={[]}
        tagsList={{}}
        accessToken="test-token"
      />
    </MountedFormHost>,
  );

describe("AdvancedSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePtuCostAttributionEnabled.mockReturnValue(false);
  });

  it("should render", () => {
    renderAdvancedSettings();
  });

  it("should render tags list", async () => {
    const { getByText } = renderAdvancedSettings();
    fireEvent.click(getByText("Advanced Settings"));
    await waitFor(() => {
      expect(getByText("Tags")).toBeInTheDocument();
    });
  });

  it("should render the litellm params", async () => {
    const { getByText } = renderAdvancedSettings();
    act(() => {
      fireEvent.click(getByText("Advanced Settings"));
    });
    await waitFor(() => {
      expect(getByText("LiteLLM Params")).toBeInTheDocument();
    });
  });

  it("hides every PTU field when PTU cost attribution is disabled", async () => {
    const { getByText, queryByText } = renderAdvancedSettings();
    act(() => {
      fireEvent.click(getByText("Advanced Settings"));
    });
    await waitFor(() => {
      expect(getByText("Tags")).toBeInTheDocument();
    });

    for (const label of PTU_LABELS) {
      expect(queryByText(label)).not.toBeInTheDocument();
    }
    expect(queryByText("PTU Effective To (UTC)")).not.toBeInTheDocument();
  });

  it("shows every PTU field when PTU cost attribution is enabled", async () => {
    mockUsePtuCostAttributionEnabled.mockReturnValue(true);
    const { getByText } = renderAdvancedSettings();
    act(() => {
      fireEvent.click(getByText("Advanced Settings"));
    });

    await waitFor(() => {
      expect(getByText("PTU Count")).toBeInTheDocument();
    });
    for (const label of PTU_LABELS) {
      expect(getByText(label)).toBeInTheDocument();
    }
    expect(getByText("PTU Effective To (UTC)")).toBeInTheDocument();
  });

  it("offers a per-minute and a per-day request cap for the key being added", async () => {
    const { getByText, getByLabelText } = renderAdvancedSettings();
    act(() => {
      fireEvent.click(getByText("Advanced Settings"));
    });

    await waitFor(() => {
      expect(getByText("Requests Per Minute")).toBeInTheDocument();
    });
    expect(getByLabelText("Requests Per Minute")).toHaveValue("");
    expect(getByLabelText("Requests Per Day")).toHaveValue("");
  });

  it("refuses a cap that is not a whole number of requests", async () => {
    const { getByText, findByLabelText, findByText } = renderAdvancedSettings();
    act(() => {
      fireEvent.click(getByText("Advanced Settings"));
    });

    fireEvent.change(await findByLabelText("Requests Per Minute"), { target: { value: "2.5" } });

    expect(await findByText("Enter a whole number of requests")).toBeInTheDocument();
  });

  it("counts those caps per model until the whole key is said to share one allowance", async () => {
    const { getByText, findByRole, getByRole } = renderAdvancedSettings();
    act(() => {
      fireEvent.click(getByText("Advanced Settings"));
    });

    const perModel = await findByRole("radio", { name: /Per model/ });
    const shared = getByRole("radio", { name: /Shared across models/ });
    expect(perModel).toBeChecked();
    expect(shared).not.toBeChecked();

    fireEvent.click(shared);

    await waitFor(() => {
      expect(shared).toBeChecked();
    });
    expect(perModel).not.toBeChecked();
  });

  it("asks for a temperature to send only once the operator chooses to pin one", async () => {
    const { getByText, findByRole, findByLabelText, findByText, queryByLabelText } = renderAdvancedSettings();
    act(() => {
      fireEvent.click(getByText("Advanced Settings"));
    });

    const pin = await findByRole("radio", { name: /Always send this value/ });
    expect(queryByLabelText("Temperature To Send Instead")).not.toBeInTheDocument();

    fireEvent.click(pin);

    fireEvent.change(await findByLabelText("Temperature To Send Instead"), { target: { value: "9" } });

    expect(await findByText("Enter a temperature between 0 and 2")).toBeInTheDocument();
  });
});
