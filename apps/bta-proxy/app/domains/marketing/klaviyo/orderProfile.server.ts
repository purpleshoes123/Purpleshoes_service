import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type KlaviyoOrderProfile = {
  email: string | null;
  customerId: string | null;
  source: "payload" | "admin" | "none";
};

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") ? normalized : null;
}

export function normalizeCustomerGid(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith("gid://shopify/Customer/")) {
    return raw;
  }
  if (raw.startsWith("gid://")) {
    return raw;
  }
  return `gid://shopify/Customer/${raw}`;
}

function extractPayloadProfile(payload: any): KlaviyoOrderProfile {
  const email =
    normalizeEmail(payload?.email) ||
    normalizeEmail(payload?.customer_email) ||
    normalizeEmail(payload?.contact_email) ||
    normalizeEmail(payload?.customer?.email) ||
    normalizeEmail(payload?.customer?.email_address) ||
    normalizeEmail(payload?.customer?.default_email_address?.email_address) ||
    normalizeEmail(payload?.customer?.default_email_address?.emailAddress) ||
    normalizeEmail(payload?.customer?.defaultEmailAddress?.emailAddress) ||
    normalizeEmail(payload?.customer?.defaultEmailAddress?.email_address) ||
    normalizeEmail(payload?.billing_address?.email) ||
    normalizeEmail(payload?.shipping_address?.email);
  const customerId = normalizeCustomerGid(payload?.customer?.id);

  return {
    email,
    customerId,
    source: email || customerId ? "payload" : "none",
  };
}

async function fetchAdminOrderProfile(
  admin: AdminApiContext,
  orderId: string,
): Promise<KlaviyoOrderProfile> {
  const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const query = `
    query getOrderKlaviyoProfile($id: ID!) {
      order(id: $id) {
        email
        customer {
          id
          email
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { id: orderGid } });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      order?: {
        email?: string | null;
        customer?: { id?: string | null; email?: string | null } | null;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`);
  }

  const order = payload.data?.order;
  return {
    email: normalizeEmail(order?.email) || normalizeEmail(order?.customer?.email),
    customerId: normalizeCustomerGid(order?.customer?.id),
    source: "admin",
  };
}

export async function resolveKlaviyoOrderProfile(params: {
  payload: any;
  orderId: string;
  admin?: AdminApiContext | null;
}): Promise<KlaviyoOrderProfile> {
  const payloadProfile = extractPayloadProfile(params.payload);
  if (payloadProfile.email) {
    return payloadProfile;
  }

  if (params.admin) {
    try {
      const adminProfile = await fetchAdminOrderProfile(params.admin, params.orderId);
      return {
        email: adminProfile.email,
        customerId: adminProfile.customerId || payloadProfile.customerId,
        source: adminProfile.email || adminProfile.customerId ? "admin" : "none",
      };
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Klaviyo purchase event profile fallback failed",
          orderId: params.orderId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return payloadProfile.customerId
    ? { ...payloadProfile, source: "payload" }
    : { email: null, customerId: null, source: "none" };
}
