import { storefrontGraphqlWithRetry } from "~/domains/checkout/tourCredits/shopifyRetry";

type StorefrontConfig = {
  token: string;
  version: string;
};

type CartLineInput = {
  merchandiseId: string;
  quantity: number;
  attributes?: Array<{ key: string; value: string }>;
};

type CreateCartResult = {
  cartId: string;
  checkoutUrl: string;
  appliedCodes: string[];
};

type UpdateDiscountResult = {
  checkoutUrl: string;
  appliedCodes: string[];
  warnings: string[];
};

function resolveStorefrontConfig(): StorefrontConfig {
  const token = process.env.SHOPIFY_STOREFRONT_TOKEN;
  const version = process.env.SHOPIFY_STOREFRONT_API_VERSION || "2025-01";
  if (!token) {
    throw new Error("SHOPIFY_STOREFRONT_TOKEN is not configured");
  }
  return { token, version };
}

function buildStorefrontUrl(shop: string, version: string): string {
  return `https://${shop}/api/${version}/graphql.json`;
}

function extractInvalidCodesFromErrors(
  errors: Array<{ message?: string }>,
  codes: string[],
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

async function storefrontFetch(
  shop: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const { token, version } = resolveStorefrontConfig();
  const payload = await storefrontGraphqlWithRetry(() =>
    fetch(buildStorefrontUrl(shop, version), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }),
  );
  if (payload?.errors && Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors.map((e: any) => e.message).join(", "));
  }
  return payload;
}

export async function createCart(shop: string, lines: CartLineInput[]): Promise<CreateCartResult> {
  const mutation = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
          discountCodes { code }
        }
        userErrors { field message }
      }
    }
  `;

  const payload = await storefrontFetch(shop, mutation, {
    input: {
      lines,
    },
  });

  const result = payload?.data?.cartCreate;
  const userErrors = result?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e: any) => e.message).join(", "));
  }

  const cart = result?.cart;
  if (!cart?.id || !cart?.checkoutUrl) {
    throw new Error("Cart creation failed to return checkoutUrl");
  }

  const appliedCodes = Array.isArray(cart?.discountCodes)
    ? cart.discountCodes.map((entry: any) => entry.code).filter(Boolean)
    : [];

  return {
    cartId: cart.id,
    checkoutUrl: cart.checkoutUrl,
    appliedCodes,
  };
}

export async function applyCartDiscountCodes(
  shop: string,
  cartId: string,
  codes: string[],
): Promise<UpdateDiscountResult> {
  const mutation = `
    mutation updateCartDiscounts($cartId: ID!, $codes: [String!]!) {
      cartDiscountCodesUpdate(cartId: $cartId, discountCodes: $codes) {
        cart {
          id
          checkoutUrl
          discountCodes { code }
        }
        userErrors { field message }
      }
    }
  `;

  const payload = await storefrontFetch(shop, mutation, {
    cartId,
    codes,
  });

  const result = payload?.data?.cartDiscountCodesUpdate;
  const userErrors = result?.userErrors || [];
  const warnings = userErrors.map((err: any) => err.message || "Unknown error");
  const invalidCodes = extractInvalidCodesFromErrors(userErrors, codes);
  const appliedCodes = Array.isArray(result?.cart?.discountCodes)
    ? result.cart.discountCodes.map((entry: any) => entry.code).filter(Boolean)
    : [];

  if (invalidCodes.length > 0) {
    warnings.push(`INVALID_CODES:${invalidCodes.join(",")}`);
  }

  return {
    checkoutUrl: result?.cart?.checkoutUrl || "",
    appliedCodes,
    warnings,
  };
}
