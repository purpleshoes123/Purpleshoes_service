import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMemberGuideCatalog, MEMBER_TOURS } from "./memberCatalog.server";
import { resetCouponRulesConfigCache } from "~/lib/coupons/config";
import type { SummaryDTO } from "~/lib/couponDisplay/types";

const summary = { currency: "USD", coupons: {
  guide50: { available: true, percentRate: 0.5 }, extra10: { available: true, amount: 10 },
} } as SummaryDTO;
const variants = ["1", "2", "3"].map(id => ({ id: `gid://shopify/ProductVariant/${id}`, title: `Plan ${id}`, price: "90.00", product: { status: "ACTIVE" } }));
const mockAdmin = (nodes: unknown[] = variants, currencyCode = "USD", errors?: unknown[]) => ({ graphql: vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { nodes, shop: { currencyCode } }, errors }))) }) as unknown as AdminApiContext;

beforeEach(() => {
  vi.stubEnv("GUIDE_BASE_VARIANT_ID_PDF", "1");
  vi.stubEnv("GUIDE_BASE_VARIANT_ID_BUNDLE", "2");
  vi.stubEnv("GUIDE_BASE_VARIANT_ID_VIDEO", "3");
  resetCouponRulesConfigCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetCouponRulesConfigCache(); });

describe("member catalog", () => {
  it("loads only server-configured variants and discounts only the eligible bundle", async () => {
    const admin = mockAdmin();
    const result = await readMemberGuideCatalog(admin, summary);
    expect(result.plans.map(p => p.memberPriceCents)).toEqual([9000, 4500, 9000]);
    expect(result.plans.map(p => p.extraPriceCents)).toEqual([8000, 3500, 8000]);
    expect(admin.graphql).toHaveBeenCalledWith(expect.any(String), { variables: { ids: variants.map(v => v.id) } });
    expect(JSON.stringify(result)).not.toContain('"code"');
  });
  it("does not display unavailable discounts", async () => {
    const noDiscount = { ...summary, coupons: { guide50: { ...summary.coupons.guide50, available: false }, extra10: { ...summary.coupons.extra10, available: false } } };
    expect((await readMemberGuideCatalog(mockAdmin(), noDiscount)).plans.map(p => p.extraPriceCents)).toEqual([9000, 9000, 9000]);
  });
  it.each([null, { ...variants[0], product: { status: "DRAFT" } }, { ...variants[0], price: "NaN" }])("fails closed for unavailable or invalid plans", async bad => {
    await expect(readMemberGuideCatalog(mockAdmin([bad, ...variants.slice(1)]), summary)).rejects.toThrow();
  });
  it("does not invent FX conversions", async () => {
    await expect(readMemberGuideCatalog(mockAdmin(variants, "AUD"), summary)).rejects.toThrow("currency");
  });
  it("does not return partial GraphQL results", async () => {
    await expect(readMemberGuideCatalog(mockAdmin(variants, "USD", [{ message: "error" }]), summary)).rejects.toThrow();
  });
  it("fails closed for missing variant configuration", async () => {
    vi.stubEnv("GUIDE_BASE_VARIANT_ID_PDF", "");
    const admin = mockAdmin();
    await expect(readMemberGuideCatalog(admin, summary)).rejects.toThrow("configured");
    expect(admin.graphql).not.toHaveBeenCalled();
  });
  it("does not allow arbitrary test tours", () => {
    expect(Object.keys(MEMBER_TOURS)).toEqual(["a-day-outside-seoul"]);
    expect(Object.hasOwn(MEMBER_TOURS, "test-tour5")).toBe(false);
  });
});
