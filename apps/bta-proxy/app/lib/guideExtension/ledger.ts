import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { EntitlementType, LedgerEventType } from "./types";

export interface LedgerEvent {
  id: string;
  entitlementType: EntitlementType;
  eventType: LedgerEventType;
  months: number;
  occurredAt: string;
  orderId?: string;
  lineItemId?: string;
  refundId?: string;
  note?: string;
  baseExpiresAt?: string;
}

const GUIDE_LEDGER_METAOBJECT_TYPE =
  process.env.GUIDE_LEDGER_METAOBJECT_TYPE || "guide_entitlement_event";

/**
 * Normalize customer ID to Shopify GID format.
 */
function normalizeCustomerGid(customerId: string): string {
  if (customerId.startsWith("gid://")) {
    return customerId;
  }
  return `gid://shopify/Customer/${customerId}`;
}

function toHandleSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeOrderId(orderId?: string | null): string | null {
  if (!orderId) return null;
  const raw = String(orderId).trim();
  if (!raw) return null;
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    return parts[parts.length - 1] || null;
  }
  return raw;
}

export function buildBaseEventHandle(
  customerId: string,
  type: EntitlementType,
  orderId?: string
): string {
  const gid = normalizeCustomerGid(customerId);
  const match = gid.match(/\/Customer\/(\d+)$/);
  const customerSegment = match ? match[1] : toHandleSegment(gid);
  const orderSegment = toHandleSegment(normalizeOrderId(orderId) || "");
  if (orderSegment) {
    return `base-${type.toLowerCase()}-${customerSegment}-${orderSegment}`;
  }
  return `base-${type.toLowerCase()}-${customerSegment}`;
}

/**
 * Parse metaobject fields into LedgerEvent.
 */
function parseLedgerEvent(node: {
  id: string;
  fields: Array<{ key: string; value: string }>;
}): LedgerEvent {
  const fieldMap: Record<string, string> = {};
  for (const field of node.fields) {
    fieldMap[field.key] = field.value;
  }

  const entitlementType = fieldMap.entitlement_type as EntitlementType | undefined;
  const eventType = fieldMap.event_type as LedgerEventType | undefined;
  const monthsValue = fieldMap.months;
  const occurredAt = fieldMap.occurred_at;

  if (!entitlementType || !["PDF", "VIDEO", "BUNDLE"].includes(entitlementType)) {
    throw new Error(`Invalid entitlement_type: ${fieldMap.entitlement_type}`);
  }

  if (!eventType || !["BASE", "EXTEND", "REFUND"].includes(eventType)) {
    throw new Error(`Invalid event_type: ${fieldMap.event_type}`);
  }

  const months = Number.parseInt(monthsValue, 10);
  if (!Number.isInteger(months)) {
    throw new Error(`Invalid months: ${monthsValue}`);
  }

  if (!occurredAt) {
    throw new Error("Missing occurred_at field");
  }

  return {
    id: node.id,
    entitlementType,
    eventType,
    months,
    occurredAt,
    orderId: fieldMap.order_id || undefined,
    lineItemId: fieldMap.line_item_id || undefined,
    refundId: fieldMap.refund_id || undefined,
    note: fieldMap.note || undefined,
    baseExpiresAt: fieldMap.base_expires_at || undefined,
  };
}

/**
 * List ledger events for a customer and type.
 */
export async function listLedgerEvents(
  admin: AdminApiContext,
  params: { customerId: string; type: EntitlementType }
): Promise<LedgerEvent[]> {
  const customerGid = normalizeCustomerGid(params.customerId);
  const query = `fields.customer_id:${JSON.stringify(customerGid)} AND fields.entitlement_type:${JSON.stringify(params.type)}`;

  const listQuery = `
    query listLedgerEvents($type: String!, $first: Int!, $after: String, $query: String) {
      metaobjects(type: $type, first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            fields { key value }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const nodes: Array<{
    id: string;
    fields: Array<{ key: string; value: string }>;
  }> = [];
  let after: string | null = null;

  do {
    const response = await admin.graphql(listQuery, {
      variables: {
        type: GUIDE_LEDGER_METAOBJECT_TYPE,
        first: 250,
        after,
        query,
      },
    });

    if (!response.ok) {
      throw new Error(`Shopify Admin API request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: {
        metaobjects?: {
          edges?: Array<{
            node: {
              id: string;
              fields: Array<{ key: string; value: string }>;
            };
          }>;
          pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(
        `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`
      );
    }

    const connection = payload.data?.metaobjects;
    nodes.push(...(connection?.edges || []).map((edge) => edge.node));
    if (!connection?.pageInfo?.hasNextPage) break;
    if (!connection.pageInfo.endCursor) {
      throw new Error("Missing metaobject pagination cursor");
    }
    after = connection.pageInfo.endCursor;
  } while (after);

  return nodes
    .filter((node) => {
      const field = (key: string) =>
        node.fields.find((item) => item.key === key)?.value;
      return (
        field("customer_id") === customerGid &&
        field("entitlement_type") === params.type
      );
    })
    .map(parseLedgerEvent);
}

/**
 * Append a ledger event (metaobjectCreate).
 */
export async function appendLedgerEvent(
  admin: AdminApiContext,
  input: {
    customerId: string;
    entitlementType: EntitlementType;
    eventType: LedgerEventType;
    months: number;
    occurredAt: string;
    orderId?: string;
    lineItemId?: string;
    refundId?: string;
    note?: string;
    baseExpiresAt?: string;
    handle?: string;
  }
): Promise<{ id: string }> {
  const fields: Array<{ key: string; value: string }> = [
    { key: "customer_id", value: normalizeCustomerGid(input.customerId) },
    { key: "entitlement_type", value: input.entitlementType },
    { key: "event_type", value: input.eventType },
    { key: "months", value: String(input.months) },
    { key: "occurred_at", value: input.occurredAt },
  ];

  if (input.orderId) fields.push({ key: "order_id", value: input.orderId });
  if (input.lineItemId) fields.push({ key: "line_item_id", value: input.lineItemId });
  if (input.refundId) fields.push({ key: "refund_id", value: input.refundId });
  if (input.note) fields.push({ key: "note", value: input.note });
  if (input.baseExpiresAt) {
    fields.push({ key: "base_expires_at", value: input.baseExpiresAt });
  }

  const mutation = `
    mutation createLedgerEvent($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: {
      metaobject: {
        type: GUIDE_LEDGER_METAOBJECT_TYPE,
        ...(input.handle ? { handle: input.handle } : {}),
        fields,
      },
    },
  });

  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id?: string };
        userErrors?: Array<{ message: string; field?: string[] }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`
    );
  }

  const userErrors = payload.data?.metaobjectCreate?.userErrors || [];
  if (userErrors.length > 0) {
    const handleErrors = userErrors.filter((error) => {
      const field = Array.isArray(error.field)
        ? error.field.join(".")
        : "";
      return field.includes("handle") || /handle/i.test(error.message);
    });
    if (input.handle && handleErrors.length === userErrors.length) {
      return { id: payload.data?.metaobjectCreate?.metaobject?.id || "existing" };
    }
    throw new Error(
      `User errors: ${userErrors.map((e) => e.message).join(", ")}`
    );
  }

  const id = payload.data?.metaobjectCreate?.metaobject?.id;
  if (!id) {
    throw new Error("Failed to create ledger event");
  }

  return { id };
}
