import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, beforeEach, afterEach, expect } from "vitest";

const { jwtDecodeMock, consumeReturnUrlMock } = vi.hoisted(() => ({
  jwtDecodeMock: vi.fn(),
  consumeReturnUrlMock: vi.fn(),
}));

vi.mock("next/navigation", () => {
  const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn() };
  return {
    __esModule: true,
    useSearchParams: () => new URLSearchParams(""),
    useRouter: () => router,
    usePathname: () => "/",
    redirect: vi.fn(),
    notFound: vi.fn(),
  };
});

vi.mock("@/components/networking", () => ({
  getUiConfig: vi.fn().mockResolvedValue({}),
  setGlobalLitellmHeaderName: vi.fn(),
  proxyBaseUrl: "https://example.com",
  serverRootPath: "/",
}));

vi.mock("jwt-decode", () => ({ jwtDecode: (token: string) => jwtDecodeMock(token) }));

vi.mock("@/utils/returnUrlUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/returnUrlUtils")>()),
  consumeReturnUrl: consumeReturnUrlMock,
}));

vi.mock("@/app/(dashboard)/api-keys/ApiKeysDashboard", () => ({
  default: () => React.createElement("div", { "data-testid": "api-keys-dashboard" }),
}));

import CreateKeyPage from "@/app/(dashboard)/page";
import { AuthProvider } from "@/contexts/AuthContext";

function PageUnderTest() {
  return (
    <AuthProvider>
      <CreateKeyPage />
    </AuthProvider>
  );
}

const validClaims = () => ({
  exp: Math.floor(Date.now() / 1000) + 60 * 60,
  key: "accessKey-123",
  user_role: "app_user",
  user_email: "user@example.com",
  login_method: "username_password",
  premium_user: false,
  auth_header_name: "x-litellm-auth",
  user_id: "u_123",
});

const originalLocation = window.location;

const stubLocation = (href: string) => {
  delete (window as unknown as { location?: Location }).location;
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, href, origin: "http://localhost", assign: vi.fn(), replace: vi.fn() },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  document.cookie = "token=; Max-Age=0; Path=/";
  consumeReturnUrlMock.mockReturnValue(null);
  stubLocation("http://localhost/");
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: originalLocation });
});

describe("CreateKeyPage auth behavior", () => {
  it("redirects to SSO when cookie token is expired and clears it (no spasms)", async () => {
    document.cookie = "token=expiredtoken";
    jwtDecodeMock.mockImplementation((token: string) => {
      expect(token).toBe("expiredtoken");
      return { exp: Math.floor(Date.now() / 1000) - 60 };
    });
    const cookieSetSpy = vi.spyOn(document, "cookie", "set");

    render(<PageUnderTest />);

    await waitFor(() =>
      expect(window.location.replace).toHaveBeenCalledWith(
        expect.stringContaining("https://example.com/ui/login/?redirect_to="),
      ),
    );
    expect(
      cookieSetSpy.mock.calls.some(
        (args) => typeof args[0] === "string" && args[0].includes("Max-Age=0") && args[0].startsWith("token="),
      ),
    ).toBe(true);
  });

  it("does NOT redirect when token is valid and renders the page content", async () => {
    document.cookie = "token=validtoken";
    jwtDecodeMock.mockImplementation((token: string) => {
      expect(token).toBe("validtoken");
      return validClaims();
    });

    render(<PageUnderTest />);

    expect(await screen.findByTestId("api-keys-dashboard")).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it("should not redirect when return URL only differs by query order", async () => {
    document.cookie = "token=validtoken";
    jwtDecodeMock.mockImplementation(() => validClaims());
    stubLocation("http://localhost/ui?b=2&a=1");
    consumeReturnUrlMock.mockReturnValue("http://localhost/ui?a=1&b=2");

    render(<PageUnderTest />);

    expect(await screen.findByTestId("api-keys-dashboard")).toBeInTheDocument();
    expect(window.location.replace).not.toHaveBeenCalled();
  });
});
