import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, waitFor } from "../../../../tests/test-utils";
import UserDropdown from "./UserDropdown";

interface AuthMock {
  userId: string | null;
  userEmail: string | null;
  userRoleLabel: string;
  premiumUser: boolean;
}

let mockUseAuthorizedImpl: () => AuthMock = () => ({
  userId: "test-user-id",
  userEmail: "test@example.com",
  userRoleLabel: "Admin",
  premiumUser: false,
});

let mockGetLocalStorageItemImpl = (key: string): string | null => {
  if (key === "disableShowNewBadge") return null;
  return null;
};

vi.mock("@/app/(dashboard)/hooks/useAuthorized", () => ({
  default: () => mockUseAuthorizedImpl(),
}));

vi.mock("@/utils/localStorageUtils", () => ({
  LOCAL_STORAGE_EVENT: "local-storage-change",
  getLocalStorageItem: (key: string) => mockGetLocalStorageItemImpl(key),
  setLocalStorageItem: vi.fn(),
  removeLocalStorageItem: vi.fn(),
  emitLocalStorageChange: vi.fn(),
}));

describe("UserDropdown", () => {
  const mockOnLogout = vi.fn();

  const getAccountTrigger = () => screen.getByRole("button", { name: /account menu/i });

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthorizedImpl = () => ({
      userId: "test-user-id",
      userEmail: "test@example.com",
      userRoleLabel: "Admin",
      premiumUser: false,
    });
    mockGetLocalStorageItemImpl = (key: string): string | null => {
      if (key === "disableShowNewBadge") return null;
      return null;
    };
  });

  it("should render", () => {
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);
    expect(getAccountTrigger()).toBeInTheDocument();
  });

  it("should surface initials and account menu affordance", () => {
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);
    expect(getAccountTrigger()).toBeInTheDocument();
    expect(screen.getByText("TE")).toBeInTheDocument();
  });

  it("should show user email when dropdown is opened", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getAllByText("test@example.com").length).toBeGreaterThan(0);
    });
  });

  it("should show user ID when dropdown is opened", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getByText("test-user-id")).toBeInTheDocument();
    });
  });

  it("should show user role when dropdown is opened", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getAllByText("Admin").length).toBeGreaterThan(0);
    });
  });

  it("should display Standard badge for non-premium users", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getByText("Standard")).toBeInTheDocument();
    });
  });

  it("should display Premium badge for premium users", async () => {
    const user = userEvent.setup();
    mockUseAuthorizedImpl = () => ({
      userId: "test-user-id",
      userEmail: "test@example.com",
      userRoleLabel: "Admin",
      premiumUser: true,
    });

    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getByText("Premium")).toBeInTheDocument();
    });
  });

  it("should call onLogout when logout is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getAllByText("test@example.com").length).toBeGreaterThan(0);
    });

    await user.click(screen.getByText("Logout"));

    expect(mockOnLogout).toHaveBeenCalledTimes(1);
  });

  it("should toggle hide new feature indicators switch", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getAllByText("test@example.com").length).toBeGreaterThan(0);
    });

    const toggle = screen.getByLabelText("Toggle hide new feature indicators");
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    const localStorageUtils = vi.mocked(await import("@/utils/localStorageUtils"));
    expect(localStorageUtils.setLocalStorageItem).toHaveBeenCalledWith("disableShowNewBadge", "true");
    expect(localStorageUtils.emitLocalStorageChange).toHaveBeenCalledWith("disableShowNewBadge");
  });

  it("should toggle hide new feature indicators switch off", async () => {
    const user = userEvent.setup();
    mockGetLocalStorageItemImpl = (key: string): string | null => {
      if (key === "disableShowNewBadge") return "true";
      return null;
    };

    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getAllByText("test@example.com").length).toBeGreaterThan(0);
    });

    const toggle = screen.getByLabelText("Toggle hide new feature indicators");
    expect(toggle).toBeChecked();

    await user.click(toggle);

    const localStorageUtils = vi.mocked(await import("@/utils/localStorageUtils"));
    expect(localStorageUtils.removeLocalStorageItem).toHaveBeenCalledWith("disableShowNewBadge");
    expect(localStorageUtils.emitLocalStorageChange).toHaveBeenCalledWith("disableShowNewBadge");
  });

  it("should show Account in the trigger when user id is the default placeholder", () => {
    mockUseAuthorizedImpl = () => ({
      userId: "default_user_id",
      userEmail: null,
      userRoleLabel: "Admin",
      premiumUser: false,
    });
    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);
    expect(screen.getByText("Account")).toBeInTheDocument();
  });

  it("should display dash when user email is not available", async () => {
    const user = userEvent.setup();
    mockUseAuthorizedImpl = () => ({
      userId: "test-user-id",
      userEmail: null,
      userRoleLabel: "Admin",
      premiumUser: false,
    });

    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getByText("-")).toBeInTheDocument();
    });
  });

  it("should display dash when user ID is not available", async () => {
    const user = userEvent.setup();
    mockUseAuthorizedImpl = () => ({
      userId: null,
      userEmail: "test@example.com",
      userRoleLabel: "Admin",
      premiumUser: false,
    });

    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      const dashElements = screen.getAllByText("-");
      expect(dashElements.length).toBeGreaterThan(0);
    });
  });

  it("should initialize hide new feature indicators from localStorage", async () => {
    const user = userEvent.setup();
    mockGetLocalStorageItemImpl = (key: string): string | null => {
      if (key === "disableShowNewBadge") return "true";
      return null;
    };

    renderWithProviders(<UserDropdown onLogout={mockOnLogout} />);

    await user.click(getAccountTrigger());

    await waitFor(() => {
      expect(screen.getAllByText("test@example.com").length).toBeGreaterThan(0);
    });

    const toggle = screen.getByLabelText("Toggle hide new feature indicators");
    expect(toggle).toBeChecked();
  });
});
