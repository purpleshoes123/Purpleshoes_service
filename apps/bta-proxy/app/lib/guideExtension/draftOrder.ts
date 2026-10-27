import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Normalize customer ID to Shopify GID format.
 */
function normalizeCustomerGid(customerId: string): string {
  if (customerId.startsWith("gid://")) {
    return customerId;
  }
  return `gid://shopify/Customer/${customerId}`;
}

/**
 * Normalize variant ID to Shopify GID format.
 */
function normalizeVariantGid(variantId: string): string {
  if (variantId.startsWith("gid://")) {
    return variantId;
  }
  return `gid://shopify/ProductVariant/${variantId}`;
}

/**
 * Create a draft order for guide extension purchase.
 */
export async function createGuideExtensionDraftOrder(
  admin: AdminApiContext,
  params: {
    customerId: string;
    variantId: string;
    quantityMonths: number;
    tags?: string[];
    note?: string;
  }
): Promise<{ draftOrderId: string; checkoutUrl: string }> {
  if (!Number.isInteger(params.quantityMonths) || params.quantityMonths < 1) {
    throw new Error("quantityMonths must be an integer >= 1");
  }

  const input = {
    customerId: normalizeCustomerGid(params.customerId),
    lineItems: [
      {
        variantId: normalizeVariantGid(params.variantId),
        quantity: params.quantityMonths,
      },
    ],
    ...(params.tags ? { tags: params.tags } : {}),
    ...(params.note ? { note: params.note } : {}),
  };

  const mutation = `
    mutation createDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
        }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, { variables: { input } });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      draftOrderCreate?: {
        draftOrder?: { id?: string; invoiceUrl?: string | null };
        userErrors?: Array<{ message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`
    );
  }

  const userErrors = payload.data?.draftOrderCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(
      `User errors: ${userErrors.map((e) => e.message).join(", ")}`
    );
  }

  const draftOrder = payload.data?.draftOrderCreate?.draftOrder;
  const draftOrderId = draftOrder?.id;
  const checkoutUrl = draftOrder?.invoiceUrl;

  if (!draftOrderId || !checkoutUrl) {
    // TODO(phase3): verify invoiceUrl vs checkoutUrl field in staging
    throw new Error("Draft order did not return a checkout URL");
  }

  return { draftOrderId, checkoutUrl };
}
