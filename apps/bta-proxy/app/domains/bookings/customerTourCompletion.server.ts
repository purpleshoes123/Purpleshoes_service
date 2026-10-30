import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

// Fixed store endpoints: never send a customer's access token to a request-supplied URL.
export const TOUR_CUSTOMER_API = "https://account.kpurpleshoes.com/customer/api/2026-07/graphql";
export const TOUR_SHOP = "eafxf4-t9.myshopify.com";
export const TOUR_CUSTOMER_QUERY = "query TourCustomerIdentity { customer { id } }";
export const TOUR_ORDER_QUERY = `query CustomerTourCompletion($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order { id customer { id } cancelledAt displayFinancialStatus tags }
  }
}`;

export class TourCompletionRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseTourOrderIds(value: unknown): string[] {
  const ids = (value as { orderIds?: unknown } | null)?.orderIds;
  if (
    !Array.isArray(ids) ||
    ids.length > 50 ||
    ids.some((id) => typeof id !== "string" || !/^gid:\/\/shopify\/Order\/\d+$/.test(id))
  ) {
    throw new TourCompletionRequestError(
      400,
      "VALIDATION_ERROR",
      "Expected up to 50 Shopify order IDs.",
    );
  }
  return [...new Set(ids)] as string[];
}

export async function verifyTourCustomer(authorization: string | null): Promise<string> {
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  // The legacy GKV Customer GID bearer format is NOT authentication for this route.
  if (!token || token.startsWith("gid://") || token.length > 8192) {
    throw new TourCompletionRequestError(401, "AUTH_LOGIN_REQUIRED", "Please sign in again.");
  }
  const response = await fetch(TOUR_CUSTOMER_API, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "PurpleShoes/1.0",
    },
    body: JSON.stringify({ query: TOUR_CUSTOMER_QUERY }),
  });
  const payload = await response.json().catch(() => null);
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.ok && !payload?.errors?.length && payload?.data?.customer === null)
  ) {
    throw new TourCompletionRequestError(401, "AUTH_LOGIN_REQUIRED", "Please sign in again.");
  }
  if (
    !response.ok ||
    payload?.errors?.length ||
    !/^gid:\/\/shopify\/Customer\/\d+$/.test(payload?.data?.customer?.id ?? "")
  ) {
    throw new TourCompletionRequestError(
      502,
      "SHOPIFY_ADMIN_API_ERROR",
      "Unable to verify your session.",
    );
  }
  return payload.data.customer.id;
}

type CompletionOrder = {
  id: string;
  customer?: { id: string } | null;
  cancelledAt?: string | null;
  displayFinancialStatus: string;
  tags: string[];
};

export async function readCustomerTourCompletion(
  admin: AdminApiContext,
  customerId: string,
  ids: string[],
) {
  if (!ids.length) {
    return { orders: [] };
  }
  const response = await admin.graphql(TOUR_ORDER_QUERY, { variables: { ids } });
  const payload = (await response.json()) as {
    errors?: unknown[];
    data?: { nodes?: (CompletionOrder | null)[] };
  };
  if (!response.ok || payload.errors?.length || !Array.isArray(payload.data?.nodes)) {
    throw new TourCompletionRequestError(
      502,
      "SHOPIFY_ADMIN_API_ERROR",
      "Unable to check tour completion.",
    );
  }
  // Missing, inaccessible and other-customer orders are indistinguishable; never return their tags.
  const orders = payload.data.nodes.filter((order): order is CompletionOrder =>
    Boolean(order && ids.includes(order.id) && order.customer?.id === customerId),
  );
  return {
    orders: orders.map((order) => ({
      orderId: order.id,
      completedLineItemIds:
        !order.cancelledAt && order.displayFinancialStatus === "PAID"
          ? order.tags.flatMap((tag) => {
              const id = /^bta-tour-completed-line-(\d+)$/.exec(tag)?.[1];
              return id ? [`gid://shopify/LineItem/${id}`] : [];
            })
          : [],
    })),
  };
}
