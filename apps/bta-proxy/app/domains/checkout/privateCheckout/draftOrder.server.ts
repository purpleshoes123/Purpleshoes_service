import type { AdminApiContext, ApiVersion } from "@shopify/shopify-app-react-router/server";
import {
  buildThemeCartAttributes,
  buildThemeCartProperties,
  createThemeCartPrepareId,
  type StorefrontCartLineLike,
  type ThemeCartCheckoutKind,
} from "~/domains/checkout/themeCartCheckout/types";

export const PRIVATE_DRAFT_MUTATION = `
  mutation PrivateMemberDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id invoiceUrl discountCodes }
      userErrors { field message }
    }
  }
`;

/** Only server-selected variants/codes belong here; never accept a client price override. */
export async function createPrivateCheckoutDraft(
  admin: AdminApiContext,
  params: {
    customerId: string;
    lines: StorefrontCartLineLike[];
    discountCodes: string[];
    kind: ThemeCartCheckoutKind;
    decision: string;
    tags?: string[];
    note?: string;
  },
): Promise<{
  draftOrderId: string;
  checkoutUrl: string;
  appliedCodes: string[];
  prepareId: string;
}> {
  const customerId = params.customerId.replace(/^gid:\/\/shopify\/Customer\//, "");
  if (!/^[1-9][0-9]*$/.test(customerId)) {
    throw new Error("PRIVATE_CHECKOUT_CUSTOMER_REQUIRED");
  }
  if (!params.lines.length || params.lines.length > 100) {
    throw new Error("PRIVATE_CHECKOUT_INVALID_LINES");
  }
  const prepareId = createThemeCartPrepareId(params.kind);
  const lineItems = params.lines.map((line) => {
    if (
      !/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(line.merchandiseId) ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > 100
    ) {
      throw new Error("PRIVATE_CHECKOUT_INVALID_LINES");
    }
    return {
      variantId: line.merchandiseId,
      quantity: line.quantity,
      customAttributes: Object.entries(
        buildThemeCartProperties(line.attributes, {
          prepareId,
          checkoutKind: params.kind,
        }),
      ).map(([key, value]) => ({ key, value })),
    };
  });
  const discountCodes = [...new Set(params.discountCodes)];
  const response = await admin.graphql(PRIVATE_DRAFT_MUTATION, {
    // Pin only this new operation; the installed SDK enum predates this API version.
    apiVersion: "2026-10" as ApiVersion,
    variables: {
      input: {
        purchasingEntity: { customerId: `gid://shopify/Customer/${customerId}` },
        lineItems,
        discountCodes,
        acceptAutomaticDiscounts: false,
        allowDiscountCodesInCheckout: params.kind !== "GUIDE_EXTENSION",
        customAttributes: Object.entries(
          buildThemeCartAttributes({
            prepareId,
            checkoutKind: params.kind,
            decision: params.decision,
          }),
        ).map(([key, value]) => ({ key, value })),
        tags: ["BTA_PRIVATE_CHECKOUT", params.kind, ...(params.tags || [])],
        ...(params.note ? { note: params.note } : {}),
      },
    },
  });
  if (!response.ok) {
    throw new Error(`PRIVATE_CHECKOUT_HTTP_${response.status}`);
  }
  const payload = (await response.json()) as {
    errors?: unknown[];
    data?: {
      draftOrderCreate?: {
        userErrors?: unknown[];
        draftOrder?: { id: string; invoiceUrl: string | null; discountCodes: string[] };
      };
    };
  };
  const result = payload.data?.draftOrderCreate;
  if (payload.errors?.length || result?.userErrors?.length) {
    throw new Error("PRIVATE_CHECKOUT_API_ERROR");
  }
  const draft = result?.draftOrder;
  if (!draft?.id || !draft.invoiceUrl) {
    throw new Error("PRIVATE_CHECKOUT_URL_MISSING");
  }
  const appliedCodes = draft.discountCodes || [];
  if (
    discountCodes.some(
      (code) => !appliedCodes.some((applied) => applied.toUpperCase() === code.toUpperCase()),
    )
  ) {
    // Do not expose a higher-price checkout when Shopify silently skips a promised discount.
    // Retain the draft identifier for reconciliation, never log its bearer checkout URL.
    console.warn(
      JSON.stringify({ message: "Private checkout discount rejected", draftOrderId: draft.id }),
    );
    throw new Error("PRIVATE_CHECKOUT_DISCOUNT_NOT_APPLIED");
  }
  return {
    draftOrderId: draft.id,
    checkoutUrl: draft.invoiceUrl,
    appliedCodes: discountCodes,
    prepareId,
  };
}
