import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { EntitlementType } from "./types";

export type BaseLineItemPayload = {
  id?: number | string | null;
  sku?: string | null;
  quantity?: number | null;
  variant_id?: number | string | null;
};

export type BaseLineItemMatch = {
  type: EntitlementType;
  lineItemId?: string;
  quantity?: number | null;
  variantId?: number | string | null;
};

function getBaseVariantIdMap(): Record<EntitlementType, string | null> {
  return {
    PDF: normalizeGuideVariantId(process.env.GUIDE_BASE_VARIANT_ID_PDF),
    VIDEO: normalizeGuideVariantId(process.env.GUIDE_BASE_VARIANT_ID_VIDEO),
    BUNDLE: normalizeGuideVariantId(process.env.GUIDE_BASE_VARIANT_ID_BUNDLE),
  };
}

const BASE_DEFAULT_MONTHS: Record<EntitlementType, number> = {
  PDF: 3,
  VIDEO: 3,
  BUNDLE: 6,
};

export function normalizeGuideVariantId(value?: string | number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    return parts[parts.length - 1] || null;
  }
  return raw;
}

export function extractBaseTypeFromVariantId(
  variantId: string | number | null | undefined,
): EntitlementType | null {
  const normalizedVariantId = normalizeGuideVariantId(variantId);
  if (!normalizedVariantId) {
    return null;
  }

  for (const [type, envId] of Object.entries(getBaseVariantIdMap())) {
    if (envId && envId === normalizedVariantId) {
      return type as EntitlementType;
    }
  }

  return null;
}

function resolveBaseType(lineItem: BaseLineItemPayload): EntitlementType | null {
  return extractBaseTypeFromVariantId(lineItem.variant_id ?? null);
}

export function extractBaseLineItems(lineItems: BaseLineItemPayload[]): BaseLineItemMatch[] {
  const matches: BaseLineItemMatch[] = [];
  for (const lineItem of lineItems) {
    const type = resolveBaseType(lineItem);
    if (!type) {
      continue;
    }
    matches.push({
      type,
      lineItemId: lineItem.id ? String(lineItem.id) : undefined,
      quantity: lineItem.quantity ?? null,
      variantId: lineItem.variant_id ?? null,
    });
  }
  return matches;
}

export function getBaseDefaultMonths(type: EntitlementType): number {
  return BASE_DEFAULT_MONTHS[type];
}

function toVariantGid(variantId: string | number): string {
  const raw = String(variantId).trim();
  if (raw.startsWith("gid://")) {
    return raw;
  }
  return `gid://shopify/ProductVariant/${raw}`;
}

export async function fetchVariantAccessMonths(
  admin: AdminApiContext,
  variantId: string | number,
): Promise<number | null> {
  const query = `
    query getVariantAccessMonths($id: ID!) {
      productVariant(id: $id) {
        metafield(namespace: "access", key: "months") {
          value
          type
        }
      }
    }
  `;

  const response = await admin.graphql(query, {
    variables: { id: toVariantGid(variantId) },
  });

  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      productVariant?: {
        metafield?: { value?: string | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`);
  }

  const value = payload.data?.productVariant?.metafield?.value;
  if (!value) {
    return null;
  }

  const months = Number.parseInt(String(value), 10);
  if (!Number.isInteger(months) || months <= 0) {
    return null;
  }

  return months;
}
