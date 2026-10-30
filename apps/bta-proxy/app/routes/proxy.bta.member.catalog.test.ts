import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { loader } from "./proxy.bta.member.catalog";
import { getAdminApiClient } from "~/lib/shopifyAdmin";

vi.mock("~/lib/shopifyAdmin", () => ({
  getAdminApiClient: vi.fn(),
  extractShopFromRequest: () => "test.myshopify.com",
}));
vi.mock("~/middleware/rateLimit", () => ({ enforceRateLimit: vi.fn() }));
vi.mock("~/domains/coupons/display/summary", () => ({ buildCouponSummary: vi.fn() }));
vi.mock("~/domains/bookings/bookingConfigResolver", () => ({ resolveBookingPolicy: vi.fn() }));
vi.mock("~/domains/bookings/bookingContext.server.ts", () => ({ createBookingContext: vi.fn() }));

function request(customer: string, key = "guide-plans") {
  const params = new URLSearchParams({
    shop: "test.myshopify.com",
    logged_in_customer_id: customer,
    key,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  params.set(
    "signature",
    createHmac("sha256", "test-secret")
      .update(
        [...params]
          .map(([k, v]) => `${k}=${v}`)
          .sort()
          .join(""),
      )
      .digest("hex"),
  );
  return new Request(`https://example.com/proxy/bta/member/catalog?${params}`);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SHOPIFY_API_SECRET", "test-secret");
  vi.stubEnv("BTA_PRIVATE_CHECKOUT_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("member catalog boundary", () => {
  it("denies an anonymous signed request before reading products", async () => {
    const response = await loader({ request: request("") } as Parameters<typeof loader>[0]);
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(getAdminApiClient).not.toHaveBeenCalled();
  });
  it("does not expose arbitrary handles", async () => {
    const response = await loader({ request: request("123", "test-tour5") } as Parameters<
      typeof loader
    >[0]);
    expect(response.status).toBe(404);
    expect(getAdminApiClient).not.toHaveBeenCalled();
  });
  it("remains unavailable until the approved server cutover flag", async () => {
    vi.stubEnv("BTA_PRIVATE_CHECKOUT_ENABLED", "false");
    const response = await loader({ request: request("123") } as Parameters<typeof loader>[0]);
    expect(response.status).toBe(503);
    expect(getAdminApiClient).not.toHaveBeenCalled();
  });
});
