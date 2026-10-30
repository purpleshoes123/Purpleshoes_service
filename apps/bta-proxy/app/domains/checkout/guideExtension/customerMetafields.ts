import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { EntitlementType } from "./types";

/**
 * Customer entitlement metafield values (ISO strings or null).
 */
export interface CustomerEntitlements {
  PDF?: string | null;
  VIDEO?: string | null;
  BUNDLE?: string | null;
}

const GUIDE_ACCESS_NAMESPACE = process.env.GUIDE_ACCESS_NAMESPACE || "guide_access";
const GUIDE_MF_KEYS: Record<EntitlementType, string> = {
  PDF: process.env.GUIDE_MF_PDF_KEY || "pdf_expires_at",
  VIDEO: process.env.GUIDE_MF_VIDEO_KEY || "video_expires_at",
  BUNDLE: process.env.GUIDE_MF_BUNDLE_KEY || "bundle_expires_at",
};

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
 * Fetch customer entitlement metafields.
 */
export async function getCustomerEntitlements(
  admin: AdminApiContext,
  customerId: string,
): Promise<CustomerEntitlements> {
  const customerGid = normalizeCustomerGid(customerId);

  const query = `
    query getCustomerEntitlements($id: ID!) {
      customer(id: $id) {
        pdf: metafield(namespace: "${GUIDE_ACCESS_NAMESPACE}", key: "${GUIDE_MF_KEYS.PDF}") {
          value
        }
        video: metafield(namespace: "${GUIDE_ACCESS_NAMESPACE}", key: "${GUIDE_MF_KEYS.VIDEO}") {
          value
        }
        bundle: metafield(namespace: "${GUIDE_ACCESS_NAMESPACE}", key: "${GUIDE_MF_KEYS.BUNDLE}") {
          value
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { id: customerGid } });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      customer?: {
        pdf?: { value?: string | null } | null;
        video?: { value?: string | null } | null;
        bundle?: { value?: string | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`);
  }

  const customer = payload.data?.customer;
  if (!customer) {
    return { PDF: null, VIDEO: null, BUNDLE: null };
  }

  return {
    PDF: customer.pdf?.value ?? null,
    VIDEO: customer.video?.value ?? null,
    BUNDLE: customer.bundle?.value ?? null,
  };
}

/**
 * Set customer entitlement metafield (date_time).
 */
export async function setCustomerEntitlementExpiresAt(
  admin: AdminApiContext,
  customerId: string,
  type: EntitlementType,
  expiresAtIso: string,
): Promise<void> {
  const customerGid = normalizeCustomerGid(customerId);

  const mutation = `
    mutation setCustomerEntitlementMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value type }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      metafields: [
        {
          namespace: GUIDE_ACCESS_NAMESPACE,
          key: GUIDE_MF_KEYS[type],
          ownerId: customerGid,
          type: "date_time",
          value: expiresAtIso,
        },
      ],
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      metafieldsSet?: { userErrors?: Array<{ message: string }> };
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`);
  }

  const userErrors = payload.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors: ${userErrors.map((e) => e.message).join(", ")}`);
  }
}

/**
 * Clear customer entitlement metafield (delete).
 */
export async function clearCustomerEntitlementMetafield(
  admin: AdminApiContext,
  customerId: string,
  type: EntitlementType,
): Promise<boolean> {
  const customerGid = normalizeCustomerGid(customerId);

  const bulkMutation = `
    mutation deleteCustomerEntitlementMetafields($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $metafields) {
        deletedMetafields {
          ownerId
          namespace
          key
        }
        userErrors { message }
      }
    }
  `;

  const bulkResponse = await admin.graphql(bulkMutation, {
    variables: {
      metafields: [
        {
          ownerId: customerGid,
          namespace: GUIDE_ACCESS_NAMESPACE,
          key: GUIDE_MF_KEYS[type],
        },
      ],
    },
  });

  if (!bulkResponse.ok) {
    throw new Error(`Shopify Admin API request failed with status ${bulkResponse.status}`);
  }

  const bulkPayload = (await bulkResponse.json()) as {
    data?: {
      metafieldsDelete?: {
        deletedMetafields?: Array<{ ownerId: string; namespace: string; key: string }>;
        userErrors?: Array<{ message: string }>;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (bulkPayload.errors && bulkPayload.errors.length > 0) {
    const message = bulkPayload.errors.map((e) => e.message).join(", ");
    const unsupported =
      message.includes("metafieldsDelete") || message.includes("MetafieldIdentifierInput");
    if (!unsupported) {
      throw new Error(`GraphQL errors: ${message}`);
    }
  } else if (bulkPayload.data?.metafieldsDelete) {
    const userErrors = bulkPayload.data.metafieldsDelete.userErrors || [];
    if (userErrors.length > 0) {
      throw new Error(`User errors: ${userErrors.map((e) => e.message).join(", ")}`);
    }
    const deleted = bulkPayload.data.metafieldsDelete.deletedMetafields || [];
    return deleted.length > 0;
  }

  const query = `
    query getCustomerEntitlementMetafieldId($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "${GUIDE_ACCESS_NAMESPACE}", key: "${GUIDE_MF_KEYS[type]}") {
          id
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { id: customerGid } });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: { customer?: { metafield?: { id?: string | null } | null } | null };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`);
  }

  const metafieldId = payload.data?.customer?.metafield?.id;
  if (!metafieldId) {
    return false;
  }

  const mutation = `
    mutation deleteCustomerEntitlementMetafield($input: MetafieldDeleteInput!) {
      metafieldDelete(input: $input) {
        deletedId
        userErrors { message }
      }
    }
  `;

  const deleteResponse = await admin.graphql(mutation, {
    variables: { input: { id: metafieldId } },
  });

  if (!deleteResponse.ok) {
    throw new Error(`Shopify Admin API request failed with status ${deleteResponse.status}`);
  }

  const deletePayload = (await deleteResponse.json()) as {
    data?: {
      metafieldDelete?: { deletedId?: string | null; userErrors?: Array<{ message: string }> };
    };
    errors?: Array<{ message: string }>;
  };

  if (deletePayload.errors && deletePayload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${deletePayload.errors.map((e) => e.message).join(", ")}`);
  }

  const userErrors = deletePayload.data?.metafieldDelete?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors: ${userErrors.map((e) => e.message).join(", ")}`);
  }

  return Boolean(deletePayload.data?.metafieldDelete?.deletedId);
}
