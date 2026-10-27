import type { CartDiscountAdapter, CartDiscountAdapterContext, SetCodesResult } from "./adapter";

function resolveStorefrontConfig() {
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  const version = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2025-01";
  return { token, version };
}

function buildStorefrontUrl(shop: string, version: string): string {
  return `https://${shop}/api/${version}/graphql.json`;
}

function extractInvalidCodesFromErrors(
  errors: Array<{ message?: string }>,
  codes: string[]
): string[] {
  const invalid: string[] = [];
  for (const error of errors) {
    const message = (error.message || "").toUpperCase();
    for (const code of codes) {
      if (message.includes(code.toUpperCase())) {
        invalid.push(code);
      }
    }
  }
  return Array.from(new Set(invalid));
}

export class StorefrontCartDiscountAdapter implements CartDiscountAdapter {
  async getAppliedCodes(ctx: CartDiscountAdapterContext): Promise<string[]> {
    if (!ctx.shop) {
      throw new Error("shop is required for Storefront adapter");
    }

    const { token, version } = resolveStorefrontConfig();
    if (!token) {
      throw new Error("SHOPIFY_STOREFRONT_TOKEN is not configured");
    }

    const query = `
      query getCartDiscounts($id: ID!) {
        cart(id: $id) {
          id
          discountCodes {
            code
          }
        }
      }
    `;

    const response = await fetch(buildStorefrontUrl(ctx.shop, version), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({ query, variables: { id: ctx.cartId } }),
    });

    if (!response.ok) {
      throw new Error(`Storefront API request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: { cart?: { discountCodes?: Array<{ code: string }> } | null };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((e) => e.message).join(", "));
    }

    const codes = payload.data?.cart?.discountCodes || [];
    return codes.map((entry) => entry.code);
  }

  async setAppliedCodes(
    ctx: CartDiscountAdapterContext,
    codes: string[]
  ): Promise<SetCodesResult> {
    if (!ctx.shop) {
      throw new Error("shop is required for Storefront adapter");
    }

    const { token, version } = resolveStorefrontConfig();
    if (!token) {
      throw new Error("SHOPIFY_STOREFRONT_TOKEN is not configured");
    }

    const mutation = `
      mutation updateCartDiscounts($cartId: ID!, $codes: [String!]!) {
        cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $codes) {
          cart {
            id
            discountCodes { code }
          }
          userErrors { field message }
        }
      }
    `;

    const response = await fetch(buildStorefrontUrl(ctx.shop, version), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({
        query: mutation,
        variables: { cartId: ctx.cartId, codes },
      }),
    });

    if (!response.ok) {
      throw new Error(`Storefront API request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: {
        cartDiscountCodesUpdate?: {
          cart?: { discountCodes?: Array<{ code: string }> } | null;
          userErrors?: Array<{ field?: string[]; message?: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      return {
        appliedCodes: [],
        invalidCodes: [],
        warnings: payload.errors.map((e) => e.message),
      };
    }

    const update = payload.data?.cartDiscountCodesUpdate;
    const userErrors = update?.userErrors || [];
    const warnings = userErrors.map((error) => error.message || "Unknown error");
    const invalidCodes = extractInvalidCodesFromErrors(userErrors, codes);

    const appliedCodes = update?.cart?.discountCodes
      ? update.cart.discountCodes.map((entry) => entry.code)
      : [];

    return {
      appliedCodes,
      invalidCodes,
      warnings,
    };
  }
}
