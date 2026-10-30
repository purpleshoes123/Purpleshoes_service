import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { Tour15ConsumedSourceType } from "~/domains/coupons/tour15Sources";
import { adminGraphqlWithRetry } from "./shopifyRetry";

const CUSTOMER_NAMESPACE = "custom";
const CUSTOMER_CREDIT_KEY = "tour15_credit_balance";
const ORDER_GRANTED_KEY = "tour15_credit_granted";
const ORDER_CONSUMED_KEY = "tour15_credit_consumed";
const ORDER_CONSUMED_CODE_KEY = "tour15_credit_consumed_code";
const ORDER_CONSUMED_KIND_KEY = "tour15_credit_consumed_kind";
const ORDER_CONSUMED_SOURCE_TYPE_KEY = "tour15_credit_consumed_source_type";
const ORDER_CONSUMED_SOURCE_ORDER_ID_KEY = "tour15_credit_consumed_source_order_id";
const ORDER_CONSUMED_AT_KEY = "tour15_credit_consumed_at";
const ORDER_RESTORED_KEY = "tour15_credit_restored";
const ORDER_RESTORED_AT_KEY = "tour15_credit_restored_at";

export type TourCreditConsumedSnapshot = {
  consumed: boolean;
  restored: boolean;
  code: string | null;
  kind: "TOUR15" | "TOUR20" | null;
  sourceType: Tour15ConsumedSourceType | null;
  sourceOrderId: string | null;
  consumedAt: number | null;
  restoredAt: number | null;
};

function normalizeCustomerGid(customerId: string): string {
  if (customerId.startsWith("gid://")) {
    return customerId;
  }
  return `gid://shopify/Customer/${customerId}`;
}

function normalizeOrderGid(orderId: string): string {
  if (orderId.startsWith("gid://")) {
    return orderId;
  }
  return `gid://shopify/Order/${orderId}`;
}

function parseBoolean(value?: string | null): boolean {
  if (!value) {
    return false;
  }
  return value.trim().toLowerCase() === "true";
}

function parseInteger(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.trunc(parsed);
}

function parseNullableInteger(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

function parseTourKind(value?: string | null): "TOUR15" | "TOUR20" | null {
  if (value === "TOUR15" || value === "TOUR20") {
    return value;
  }
  return null;
}

function parseSourceType(value?: string | null): Tour15ConsumedSourceType | null {
  if (
    value === "GUIDE_BUNDLE" ||
    value === "TOUR_REVIEW" ||
    value === "LEGACY" ||
    value === "UNKNOWN"
  ) {
    return value;
  }
  return null;
}

async function runQuery(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<any> {
  const payload = await adminGraphqlWithRetry(admin, query, variables);
  if (payload?.errors && Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e: any) => e.message).join(", ")}`);
  }
  return payload;
}

export async function fetchCustomerTourCreditBalance(
  admin: AdminApiContext,
  customerId: string,
): Promise<number> {
  const customerGid = normalizeCustomerGid(customerId);
  const query = `
    query getTourCreditBalance($id: ID!) {
      customer(id: $id) {
        credit: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${CUSTOMER_CREDIT_KEY}") {
          value
        }
      }
    }
  `;

  const payload = await runQuery(admin, query, { id: customerGid });
  const value = payload?.data?.customer?.credit?.value ?? null;
  return parseInteger(value);
}

export async function setCustomerTourCreditBalance(
  admin: AdminApiContext,
  customerId: string,
  value: number,
): Promise<void> {
  const customerGid = normalizeCustomerGid(customerId);
  const mutation = `
    mutation setTourCreditBalance($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;

  const payload = await runQuery(admin, mutation, {
    metafields: [
      {
        namespace: CUSTOMER_NAMESPACE,
        key: CUSTOMER_CREDIT_KEY,
        ownerId: customerGid,
        type: "number_integer",
        value: String(Math.max(0, Math.trunc(value))),
      },
    ],
  });
  const userErrors = payload?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors: ${userErrors.map((e: any) => e.message).join(", ")}`);
  }
}

export async function fetchOrderTourCreditGranted(
  admin: AdminApiContext,
  orderId: string,
): Promise<boolean> {
  const orderGid = normalizeOrderGid(orderId);
  const query = `
    query getOrderTourGrant($id: ID!) {
      order(id: $id) {
        granted: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_GRANTED_KEY}") {
          value
        }
      }
    }
  `;
  const payload = await runQuery(admin, query, { id: orderGid });
  const value = payload?.data?.order?.granted?.value ?? null;
  return parseBoolean(value);
}

export async function markOrderTourCreditGranted(
  admin: AdminApiContext,
  orderId: string,
): Promise<void> {
  const orderGid = normalizeOrderGid(orderId);
  const mutation = `
    mutation markOrderTourGrant($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const payload = await runQuery(admin, mutation, {
    metafields: [
      {
        namespace: CUSTOMER_NAMESPACE,
        key: ORDER_GRANTED_KEY,
        ownerId: orderGid,
        type: "boolean",
        value: "true",
      },
    ],
  });
  const userErrors = payload?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors: ${userErrors.map((e: any) => e.message).join(", ")}`);
  }
}

export async function fetchOrderTourCreditConsumed(
  admin: AdminApiContext,
  orderId: string,
): Promise<boolean> {
  const orderGid = normalizeOrderGid(orderId);
  const query = `
    query getOrderTourConsume($id: ID!) {
      order(id: $id) {
        consumed: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_CONSUMED_KEY}") {
          value
        }
      }
    }
  `;
  const payload = await runQuery(admin, query, { id: orderGid });
  const value = payload?.data?.order?.consumed?.value ?? null;
  return parseBoolean(value);
}

export async function markOrderTourCreditConsumed(
  admin: AdminApiContext,
  orderId: string,
  snapshot?: {
    code?: string | null;
    kind?: "TOUR15" | "TOUR20" | null;
    sourceType?: Tour15ConsumedSourceType | null;
    sourceOrderId?: string | null;
    consumedAt?: number | null;
  },
): Promise<void> {
  const orderGid = normalizeOrderGid(orderId);
  const mutation = `
    mutation markOrderTourConsume($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const metafields = [
    {
      namespace: CUSTOMER_NAMESPACE,
      key: ORDER_CONSUMED_KEY,
      ownerId: orderGid,
      type: "boolean",
      value: "true",
    },
    ...(snapshot?.code
      ? [
          {
            namespace: CUSTOMER_NAMESPACE,
            key: ORDER_CONSUMED_CODE_KEY,
            ownerId: orderGid,
            type: "single_line_text_field",
            value: snapshot.code,
          },
        ]
      : []),
    ...(snapshot?.kind
      ? [
          {
            namespace: CUSTOMER_NAMESPACE,
            key: ORDER_CONSUMED_KIND_KEY,
            ownerId: orderGid,
            type: "single_line_text_field",
            value: snapshot.kind,
          },
        ]
      : []),
    ...(snapshot?.sourceType
      ? [
          {
            namespace: CUSTOMER_NAMESPACE,
            key: ORDER_CONSUMED_SOURCE_TYPE_KEY,
            ownerId: orderGid,
            type: "single_line_text_field",
            value: snapshot.sourceType,
          },
        ]
      : []),
    ...(snapshot?.sourceOrderId
      ? [
          {
            namespace: CUSTOMER_NAMESPACE,
            key: ORDER_CONSUMED_SOURCE_ORDER_ID_KEY,
            ownerId: orderGid,
            type: "single_line_text_field",
            value: snapshot.sourceOrderId,
          },
        ]
      : []),
    ...(snapshot?.consumedAt
      ? [
          {
            namespace: CUSTOMER_NAMESPACE,
            key: ORDER_CONSUMED_AT_KEY,
            ownerId: orderGid,
            type: "number_integer",
            value: String(snapshot.consumedAt),
          },
        ]
      : []),
  ];
  const payload = await runQuery(admin, mutation, { metafields });
  const userErrors = payload?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors: ${userErrors.map((e: any) => e.message).join(", ")}`);
  }
}

export async function fetchOrderTourCreditConsumedSnapshot(
  admin: AdminApiContext,
  orderId: string,
): Promise<TourCreditConsumedSnapshot> {
  const orderGid = normalizeOrderGid(orderId);
  const query = `
    query getOrderTourCreditConsumedSnapshot($id: ID!) {
      order(id: $id) {
        consumed: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_CONSUMED_KEY}") {
          value
        }
        restored: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_RESTORED_KEY}") {
          value
        }
        consumedCode: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_CONSUMED_CODE_KEY}") {
          value
        }
        consumedKind: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_CONSUMED_KIND_KEY}") {
          value
        }
        consumedSourceType: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_CONSUMED_SOURCE_TYPE_KEY}") {
          value
        }
        consumedSourceOrderId: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_CONSUMED_SOURCE_ORDER_ID_KEY}") {
          value
        }
        consumedAt: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_CONSUMED_AT_KEY}") {
          value
        }
        restoredAt: metafield(namespace: "${CUSTOMER_NAMESPACE}", key: "${ORDER_RESTORED_AT_KEY}") {
          value
        }
      }
    }
  `;
  const payload = await runQuery(admin, query, { id: orderGid });
  const order = payload?.data?.order || {};
  return {
    consumed: parseBoolean(order.consumed?.value),
    restored: parseBoolean(order.restored?.value),
    code: order.consumedCode?.value || null,
    kind: parseTourKind(order.consumedKind?.value),
    sourceType: parseSourceType(order.consumedSourceType?.value),
    sourceOrderId: order.consumedSourceOrderId?.value || null,
    consumedAt: parseNullableInteger(order.consumedAt?.value),
    restoredAt: parseNullableInteger(order.restoredAt?.value),
  };
}

export async function markOrderTourCreditRestored(
  admin: AdminApiContext,
  orderId: string,
  restoredAt: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const orderGid = normalizeOrderGid(orderId);
  const mutation = `
    mutation markOrderTourCreditRestored($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `;
  const payload = await runQuery(admin, mutation, {
    metafields: [
      {
        namespace: CUSTOMER_NAMESPACE,
        key: ORDER_RESTORED_KEY,
        ownerId: orderGid,
        type: "boolean",
        value: "true",
      },
      {
        namespace: CUSTOMER_NAMESPACE,
        key: ORDER_RESTORED_AT_KEY,
        ownerId: orderGid,
        type: "number_integer",
        value: String(restoredAt),
      },
    ],
  });
  const userErrors = payload?.data?.metafieldsSet?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(`User errors: ${userErrors.map((e: any) => e.message).join(", ")}`);
  }
}
