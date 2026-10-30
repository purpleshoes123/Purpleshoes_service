import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { adminGraphqlWithRetry } from "./shopifyRetry";

export type TourOrderLineItem = {
  id: string;
  title?: string | null;
  quantity?: number | null;
  customAttributes: Array<{ key: string; value: string }>;
  productType?: string | null;
  tags?: string[] | null;
  collections?: string[] | null;
  productId?: string | null;
  variantId?: string | null;
};

export type TourOrderRecord = {
  id: string;
  legacyResourceId?: string | number | null;
  displayFinancialStatus?: string | null;
  tourCreditGranted?: boolean;
  lineItems: TourOrderLineItem[];
};

function normalizeOrderGid(orderId: string): string {
  if (orderId.startsWith("gid://")) {
    return orderId;
  }
  return `gid://shopify/Order/${orderId}`;
}

function normalizeCustomerGid(customerId: string): string {
  if (customerId.startsWith("gid://")) {
    return customerId;
  }
  return `gid://shopify/Customer/${customerId}`;
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

export async function fetchRecentCustomerOrders(
  admin: AdminApiContext,
  customerId: string,
  limit = 50,
): Promise<TourOrderRecord[]> {
  const customerGid = normalizeCustomerGid(customerId);
  const query = `
    query getCustomerOrders($id: ID!, $first: Int!) {
      customer(id: $id) {
        orders(first: $first, sortKey: PROCESSED_AT, reverse: true) {
          edges {
            node {
              id
              legacyResourceId
              displayFinancialStatus
              grantFlag: metafield(namespace: "custom", key: "tour15_credit_granted") {
                value
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    customAttributes { key value }
                    product {
                      id
                      productType
                      tags
                      collections(first: 10) {
                        edges { node { handle } }
                      }
                    }
                    variant { id }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const payload = await runQuery(admin, query, {
    id: customerGid,
    first: Math.min(Math.max(limit, 1), 50),
  });
  const edges = payload?.data?.customer?.orders?.edges || [];
  return edges.map((edge: any) => {
    const node = edge.node;
    const lineEdges = node?.lineItems?.edges || [];
    const lineItems: TourOrderLineItem[] = lineEdges.map((lineEdge: any) => {
      const line = lineEdge.node;
      const collections =
        line?.product?.collections?.edges?.map((c: any) => c.node?.handle).filter(Boolean) ?? [];
      return {
        id: line.id,
        title: line.title ?? null,
        quantity: typeof line.quantity === "number" ? line.quantity : null,
        customAttributes: Array.isArray(line.customAttributes) ? line.customAttributes : [],
        productType: line?.product?.productType ?? null,
        tags: Array.isArray(line?.product?.tags) ? line.product.tags : null,
        collections,
        productId: line?.product?.id ?? null,
        variantId: line?.variant?.id ?? null,
      };
    });
    return {
      id: node?.id,
      legacyResourceId: node?.legacyResourceId ?? null,
      displayFinancialStatus: node?.displayFinancialStatus ?? null,
      tourCreditGranted:
        typeof node?.grantFlag?.value === "string"
          ? node.grantFlag.value.trim().toLowerCase() === "true"
          : false,
      lineItems,
    } as TourOrderRecord;
  });
}

export async function fetchOrderDiscountCodes(
  admin: AdminApiContext,
  orderId: string,
): Promise<string[]> {
  const orderGid = normalizeOrderGid(orderId);
  const query = `
    query getOrderDiscountCodes($id: ID!) {
      order(id: $id) {
        discountApplications(first: 50) {
          edges {
            node {
              __typename
              ... on DiscountCodeApplication {
                code
              }
            }
          }
        }
      }
    }
  `;
  const payload = await runQuery(admin, query, { id: orderGid });
  const edges = payload?.data?.order?.discountApplications?.edges || [];
  const codes = edges
    .map((edge: any) => edge.node?.code)
    .filter((code: any) => typeof code === "string" && code.trim().length > 0);
  return codes as string[];
}

export async function fetchOrderDiscountsWithConsumeFlag(
  admin: AdminApiContext,
  orderId: string,
): Promise<{ codes: string[]; consumed: boolean }> {
  const orderGid = normalizeOrderGid(orderId);
  const query = `
    query getOrderDiscountsWithConsume($id: ID!) {
      order(id: $id) {
        consumed: metafield(namespace: "custom", key: "tour15_credit_consumed") {
          value
        }
        discountApplications(first: 50) {
          edges {
            node {
              __typename
              ... on DiscountCodeApplication {
                code
              }
            }
          }
        }
      }
    }
  `;
  const payload = await runQuery(admin, query, { id: orderGid });
  const edges = payload?.data?.order?.discountApplications?.edges || [];
  const codes = edges
    .map((edge: any) => edge.node?.code)
    .filter((code: any) => typeof code === "string" && code.trim().length > 0);
  const consumedRaw = payload?.data?.order?.consumed?.value ?? null;
  const consumed =
    typeof consumedRaw === "string" ? consumedRaw.trim().toLowerCase() === "true" : false;
  return { codes: codes as string[], consumed };
}
