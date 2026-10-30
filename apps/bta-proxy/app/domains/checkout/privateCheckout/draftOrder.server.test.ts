import { describe, expect, it, vi } from "vitest";
import { createPrivateCheckoutDraft } from "./draftOrder.server.ts";

const params = {
  customerId: "123",
  lines: [
    {
      merchandiseId: "gid://shopify/ProductVariant/11",
      quantity: 1,
      attributes: [{ key: "travel_date", value: "2026-11-01" }],
    },
  ],
  discountCodes: ["EXTRA10-123"],
  kind: "TOUR" as const,
  decision: "NONE",
};
function client(overrides = {}) {
  const graphql = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          draftOrderCreate: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/1",
              invoiceUrl: "https://example.com/invoices/test",
              discountCodes: ["EXTRA10-123"],
              ...overrides,
            },
            userErrors: [],
          },
        },
      }),
    ),
  );
  return { graphql };
}
describe("private member draft", () => {
  it("uses catalog prices and the authenticated customer, preserving reservation attributes", async () => {
    const admin = client();
    const result = await createPrivateCheckoutDraft(admin as never, params);
    const options = admin.graphql.mock.calls[0][1];
    expect(options.apiVersion).toBe("2026-10");
    expect(options.variables.input.purchasingEntity.customerId).toBe("gid://shopify/Customer/123");
    expect(options.variables.input.lineItems[0]).toEqual({
      variantId: "gid://shopify/ProductVariant/11",
      quantity: 1,
      customAttributes: expect.arrayContaining([
        { key: "travel_date", value: "2026-11-01" },
        { key: "_bta_checkout_kind", value: "TOUR" },
      ]),
    });
    expect(options.variables.input.lineItems[0]).not.toHaveProperty("priceOverride");
    expect(options.variables.input.acceptAutomaticDiscounts).toBe(false);
    expect(result.appliedCodes).toEqual(params.discountCodes);
    expect(result.checkoutUrl).toBe("https://example.com/invoices/test");
  });
  it("does not return an invoice when a requested discount was skipped", async () => {
    await expect(
      createPrivateCheckoutDraft(client({ discountCodes: [] }) as never, params),
    ).rejects.toThrow("PRIVATE_CHECKOUT_DISCOUNT_NOT_APPLIED");
  });
  it("accepts Shopify's case-normalized code", async () => {
    await expect(
      createPrivateCheckoutDraft(client({ discountCodes: ["extra10-123"] }) as never, params),
    ).resolves.toMatchObject({ appliedCodes: params.discountCodes });
  });
  it.each(["", "0", "gid://shopify/Product/123", "123&456"])(
    "rejects invalid customer %s",
    async (customerId) => {
      const admin = client();
      await expect(
        createPrivateCheckoutDraft(admin as never, { ...params, customerId }),
      ).rejects.toThrow();
      expect(admin.graphql).not.toHaveBeenCalled();
    },
  );
  it.each([0, -1, 1.5, 101])("rejects invalid quantity %s", async (quantity) => {
    const admin = client();
    await expect(
      createPrivateCheckoutDraft(admin as never, {
        ...params,
        lines: [{ merchandiseId: params.lines[0].merchandiseId, quantity }],
      }),
    ).rejects.toThrow();
    expect(admin.graphql).not.toHaveBeenCalled();
  });
  it("rejects GraphQL errors without exposing remote error text", async () => {
    const admin = {
      graphql: vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: "remote" }] }))),
    };
    await expect(createPrivateCheckoutDraft(admin as never, params)).rejects.toThrow(
      "PRIVATE_CHECKOUT_API_ERROR",
    );
  });
  it("rejects a missing invoice", async () => {
    await expect(
      createPrivateCheckoutDraft(client({ invoiceUrl: null }) as never, params),
    ).rejects.toThrow("PRIVATE_CHECKOUT_URL_MISSING");
  });
});
