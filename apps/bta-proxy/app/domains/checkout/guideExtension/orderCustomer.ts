import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

/**
 * Fetch customer GID for an order.
 */
export async function fetchOrderCustomerId(
  admin: AdminApiContext,
  orderId: string,
): Promise<string | null> {
  const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

  const query = `
    query getOrderCustomer($id: ID!) {
      order(id: $id) {
        customer {
          id
        }
      }
    }
  `;

  const response = await admin.graphql(query, { variables: { id: orderGid } });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    data?: { order?: { customer?: { id?: string | null } | null } | null };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`);
  }

  return payload.data?.order?.customer?.id ?? null;
}
