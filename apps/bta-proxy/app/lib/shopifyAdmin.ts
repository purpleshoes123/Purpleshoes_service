/**
 * Shopify Admin API 클라이언트 유틸리티
 * Phase 5-6: App Proxy 요청에서 shop 정보 추출 및 Admin GraphQL 클라이언트 생성
 */

import shopify from "~/shopify.server";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { loadOfflineSession, normalizeShopDomain } from "~/lib/shopifySession";

function createAdminGraphqlClient(
  shop: string,
  accessToken: string
): AdminApiContext {
  // shopify.server.ts에서 사용하는 API 버전 사용
  // ApiVersion.January25는 "2025-01"에 해당
  const apiVersionString = "2025-01";

  return {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown>; apiVersion?: string }
    ) => {
      const version = options?.apiVersion || apiVersionString;
      if (!/^202\d-(01|04|07|10)$/.test(version)) throw new Error("Invalid Admin API version");
      const graphqlUrl = `https://${shop}/admin/api/${version}/graphql.json`;
      return fetch(graphqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query,
          variables: options?.variables,
        }),
      });
    },
  } as AdminApiContext;
}

/**
 * App Proxy 요청에서 shop 도메인을 추출합니다.
 * @param request Request 객체
 * @returns shop 도메인 (예: "test-shop.myshopify.com") 또는 null
 */
export function extractShopFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  const rawShop = url.searchParams.get("shop");

  if (!rawShop) {
    return null;
  }

  const shop = normalizeShopDomain(rawShop);
  if (!shop) {
    return null;
  }

  // shop 도메인 정규화 (myshopify.com 포함 확인)
  if (shop.includes(".")) {
    return shop;
  }

  // shop 이름만 있는 경우 .myshopify.com 추가
  return `${shop}.myshopify.com`;
}

/**
 * shop 도메인으로 Admin GraphQL 클라이언트를 생성합니다.
 * @param shop shop 도메인 (예: "test-shop.myshopify.com")
 * @returns AdminApiContext 또는 null (세션 없음)
 */
export async function getAdminApiClient(
  shop: string
): Promise<AdminApiContext | null> {
  try {
    const normalizedShop = normalizeShopDomain(shop);
    // 세션 스토리지에서 세션 조회 (refresh 포함)
    const session = await loadOfflineSession(normalizedShop, {
      source: "shopifyAdmin",
    });
    if (!session || !session.accessToken) {
      return null;
    }

    const adminShopDomain = session.shop || normalizedShop;
    const fallbackAdmin = createAdminGraphqlClient(
      adminShopDomain,
      session.accessToken
    );

    // 가짜 Request 객체 생성 (authenticate.admin이 필요로 함)
    // 실제로는 세션만 있으면 되지만, authenticate.admin의 타입 요구사항을 만족시키기 위함
    const fakeRequest = new Request(
      `https://${adminShopDomain}/admin/api/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // 세션을 Request에 첨부하기 위해 authenticate.admin 사용
    // 하지만 실제로는 세션만 있으면 GraphQL 클라이언트를 생성할 수 있음
    // 임시로 Request에 세션 정보를 포함시켜 authenticate.admin 호출
    const result = await shopify.authenticate.admin(fakeRequest);
    return result?.admin || fallbackAdmin;
  } catch (error) {
    // authenticate.admin이 실패하면 세션을 직접 사용하여 GraphQL 클라이언트 생성 시도
    try {
      const normalizedShop = normalizeShopDomain(shop);
      const sessionId = `offline_${normalizedShop}`;
      const session = await shopify.sessionStorage.loadSession(sessionId);

      if (!session || !session.accessToken) {
        return null;
      }

      return createAdminGraphqlClient(
        session.shop || normalizedShop,
        session.accessToken
      );
    } catch (innerError) {
      console.error(
        JSON.stringify({
          message: "Failed to get Admin API client",
          shop: shop.substring(0, 20) + "...",
          error: error instanceof Error ? error.message : String(error),
        })
      );
      return null;
    }
  }
}

/**
 * App Proxy 요청에서 Admin GraphQL 클라이언트를 생성합니다.
 * @param request Request 객체
 * @returns AdminApiContext 또는 null
 */
export async function getAdminApiClientFromRequest(
  request: Request
): Promise<AdminApiContext | null> {
  const shop = extractShopFromRequest(request);
  if (!shop) {
    return null;
  }

  return await getAdminApiClient(shop);
}

/**
 * Shopify Order 타입
 */
export interface ShopifyOrder {
  id: string;
  createdAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus?: string | null;
  legacyResourceId?: string | number | null;
  name?: string | null;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        quantity: number;
        product?: {
          id: string;
        } | null;
        variant?: {
          id: string;
        } | null;
        title: string;
        customAttributes: Array<{
          key: string;
          value: string;
        }>;
      };
    }>;
  };
}

/**
 * Shopify Orders GraphQL 쿼리 결과
 */
export interface OrdersQueryResult {
  orders: {
    edges: Array<{
      node: ShopifyOrder;
      cursor: string;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

export interface ShopifyOrderSummary {
  id: string;
  legacyResourceId?: string | number | null;
  name?: string | null;
  lineItemTitle?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  processedAt?: string | null;
  cancelledAt?: string | null;
  email?: string | null;
  phone?: string | null;
  customer?: {
    displayName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  billingAddress?: {
    name?: string | null;
    phone?: string | null;
  } | null;
  shippingAddress?: {
    name?: string | null;
    phone?: string | null;
  } | null;
}

export interface ShopifyOrderRefundInfo {
  id: string;
  legacyResourceId?: string | number | null;
  name?: string | null;
  lineItems: Array<{
    id: string;
    title: string;
    quantity: number;
  }>;
}

/**
 * Shopify Admin GraphQL API로 주문의 line_items를 조회합니다.
 * @param admin AdminApiContext
 * @param orderId Shopify 주문 ID (숫자 문자열 또는 gid)
 * @returns line_items 배열
 */
export async function fetchOrderLineItemsGraphQL(
  admin: AdminApiContext,
  orderId: string
): Promise<
  Array<{
    id: string;
    product_id?: string;
    variant_id?: string;
    sku?: string | null;
    quantity?: number;
    properties?: Array<{ name: string; value: string }>;
  }>
> {
  const orderGid = orderId.startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const GET_ORDER_QUERY = `
    query getOrder($id: ID!) {
      order(id: $id) {
        id
        lineItems(first: 250) {
          edges {
            node {
              id
              quantity
              product { id }
              variant { id sku }
              customAttributes { key value }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(GET_ORDER_QUERY, {
    variables: { id: orderGid },
  });

  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const responseJson = await response.json();
  if (responseJson.errors) {
    const errorMessages = responseJson.errors
      .map((e: any) => e.message)
      .join(", ");
    throw new Error(`GraphQL error: ${errorMessages}`);
  }

  const order = responseJson.data?.order;
  if (!order) {
    return [];
  }

  const lineItems = order.lineItems?.edges || [];
  return lineItems.map((edge: any) => {
    const node = edge.node;
    const properties = (node.customAttributes || []).map((attr: any) => ({
      name: attr.key,
      value: attr.value,
    }));
    return {
      id: node.id?.replace("gid://shopify/LineItem/", ""),
      quantity: typeof node.quantity === "number" ? node.quantity : undefined,
      product_id: node.product?.id
        ? node.product.id.replace("gid://shopify/Product/", "")
        : undefined,
      variant_id: node.variant?.id
        ? node.variant.id.replace("gid://shopify/ProductVariant/", "")
        : undefined,
      sku: node.variant?.sku ?? null,
      properties,
    };
  });
}

/**
 * Shopify Admin GraphQL API로 주문 요약 정보를 조회합니다.
 * @param admin AdminApiContext
 * @param orderId Shopify 주문 ID (숫자 문자열 또는 gid)
 */
export async function fetchOrderSummaryGraphQL(
  admin: AdminApiContext,
  orderId: string
): Promise<ShopifyOrderSummary | null> {
  const orderGid = orderId.startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const GET_ORDER_SUMMARY_QUERY = `
    query getOrderSummary($id: ID!) {
      order(id: $id) {
        id
        legacyResourceId
        name
        lineItems(first: 1) {
          edges {
            node {
              title
            }
          }
        }
        displayFinancialStatus
        displayFulfillmentStatus
        processedAt
        cancelledAt
        email
        phone
        customer {
          displayName
          firstName
          lastName
          email
          phone
        }
        billingAddress {
          name
          phone
        }
        shippingAddress {
          name
          phone
        }
      }
    }
  `;

  const response = await admin.graphql(GET_ORDER_SUMMARY_QUERY, {
    variables: { id: orderGid },
  });

  let responseJson: any;
  if (response && typeof (response as any).json === "function") {
    const fetchResponse = response as Response;
    if (!fetchResponse.ok) {
      throw new Error(
        `Shopify Admin API request failed with status ${fetchResponse.status}`
      );
    }
    responseJson = await fetchResponse.json();
  } else {
    responseJson = response as any;
  }

  const gqlErrors =
    responseJson?.errors ||
    responseJson?.graphQLErrors ||
    responseJson?.body?.errors;
  const order =
    responseJson?.data?.order || responseJson?.body?.data?.order || null;
  if (!order) {
    if (gqlErrors) {
      const errorMessages = gqlErrors
        .map((e: any) => e.message)
        .filter(Boolean)
        .join(", ");
      if (errorMessages) {
        throw new Error(`GraphQL error: ${errorMessages}`);
      }
    }
    return null;
  }

  return {
    id: order.id,
    legacyResourceId: order.legacyResourceId,
    name: order.name,
    lineItemTitle: order.lineItems?.edges?.[0]?.node?.title ?? null,
    displayFinancialStatus: order.displayFinancialStatus,
    displayFulfillmentStatus: order.displayFulfillmentStatus,
    processedAt: order.processedAt,
    cancelledAt: order.cancelledAt,
    email: order.email ?? null,
    phone: order.phone ?? null,
    customer: order.customer,
    billingAddress: order.billingAddress ?? null,
    shippingAddress: order.shippingAddress ?? null,
  };
}

/**
 * Shopify Admin GraphQL API로 주문 요약을 검색(query)합니다.
 * @param admin AdminApiContext
 * @param query 주문 검색 쿼리 (예: "order_number:1001", "name:#1001")
 */
export async function fetchOrderSummaryByQuery(
  admin: AdminApiContext,
  query: string
): Promise<ShopifyOrderSummary | null> {
  const GET_ORDER_BY_QUERY = `
    query getOrderSummaryByQuery($first: Int!, $query: String!) {
      orders(first: $first, query: $query) {
        edges {
          node {
            id
            legacyResourceId
            name
            lineItems(first: 1) {
              edges {
                node {
                  title
                }
              }
            }
            displayFinancialStatus
            displayFulfillmentStatus
            processedAt
            cancelledAt
            email
            phone
            customer {
              displayName
              firstName
              lastName
              email
              phone
            }
            billingAddress {
              name
              phone
            }
            shippingAddress {
              name
              phone
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(GET_ORDER_BY_QUERY, {
    variables: { first: 1, query },
  });

  let responseJson: any;
  if (response && typeof (response as any).json === "function") {
    const fetchResponse = response as Response;
    if (!fetchResponse.ok) {
      throw new Error(
        `Shopify Admin API request failed with status ${fetchResponse.status}`
      );
    }
    responseJson = await fetchResponse.json();
  } else {
    responseJson = response as any;
  }

  const gqlErrors =
    responseJson?.errors ||
    responseJson?.graphQLErrors ||
    responseJson?.body?.errors;

  const order =
    responseJson?.data?.orders?.edges?.[0]?.node ||
    responseJson?.body?.data?.orders?.edges?.[0]?.node ||
    null;
  if (!order) {
    if (gqlErrors) {
      const errorMessages = gqlErrors
        .map((e: any) => e.message)
        .filter(Boolean)
        .join(", ");
      if (errorMessages) {
        throw new Error(`GraphQL error: ${errorMessages}`);
      }
    }
    return null;
  }

  return {
    id: order.id,
    legacyResourceId: order.legacyResourceId,
    name: order.name,
    lineItemTitle: order.lineItems?.edges?.[0]?.node?.title ?? null,
    displayFinancialStatus: order.displayFinancialStatus,
    displayFulfillmentStatus: order.displayFulfillmentStatus,
    processedAt: order.processedAt,
    cancelledAt: order.cancelledAt,
    email: order.email ?? null,
    phone: order.phone ?? null,
    customer: order.customer,
    billingAddress: order.billingAddress ?? null,
    shippingAddress: order.shippingAddress ?? null,
  };
}

export async function fetchOrderRefundInfoGraphQL(
  admin: AdminApiContext,
  orderId: string
): Promise<ShopifyOrderRefundInfo | null> {
  const orderGid = orderId.startsWith("gid://")
    ? orderId
    : `gid://shopify/Order/${orderId}`;

  const GET_ORDER_REFUND_QUERY = `
    query getOrderRefundInfo($id: ID!) {
      order(id: $id) {
        id
        legacyResourceId
        name
        lineItems(first: 250) {
          edges {
            node {
              id
              title
              quantity
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(GET_ORDER_REFUND_QUERY, {
    variables: { id: orderGid },
  });

  let responseJson: any;
  if (response && typeof (response as any).json === "function") {
    const fetchResponse = response as Response;
    if (!fetchResponse.ok) {
      throw new Error(
        `Shopify Admin API request failed with status ${fetchResponse.status}`
      );
    }
    responseJson = await fetchResponse.json();
  } else {
    responseJson = response as any;
  }

  const gqlErrors =
    responseJson?.errors ||
    responseJson?.graphQLErrors ||
    responseJson?.body?.errors;
  const order =
    responseJson?.data?.order || responseJson?.body?.data?.order || null;
  if (!order) {
    if (gqlErrors) {
      const errorMessages = gqlErrors
        .map((e: any) => e.message)
        .filter(Boolean)
        .join(", ");
      if (errorMessages) {
        throw new Error(`GraphQL error: ${errorMessages}`);
      }
    }
    return null;
  }

  return {
    id: order.id,
    legacyResourceId: order.legacyResourceId,
    name: order.name ?? null,
    lineItems: order.lineItems?.edges?.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      quantity: edge.node.quantity,
    })) ?? [],
  };
}

export async function fetchOrderRefundInfoByQuery(
  admin: AdminApiContext,
  query: string
): Promise<ShopifyOrderRefundInfo | null> {
  const GET_ORDER_BY_QUERY = `
    query getOrderRefundInfoByQuery($first: Int!, $query: String!) {
      orders(first: $first, query: $query) {
        edges {
          node {
            id
            legacyResourceId
            name
            lineItems(first: 250) {
              edges {
                node {
                  id
                  title
                  quantity
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(GET_ORDER_BY_QUERY, {
    variables: { first: 1, query },
  });

  let responseJson: any;
  if (response && typeof (response as any).json === "function") {
    const fetchResponse = response as Response;
    if (!fetchResponse.ok) {
      throw new Error(
        `Shopify Admin API request failed with status ${fetchResponse.status}`
      );
    }
    responseJson = await fetchResponse.json();
  } else {
    responseJson = response as any;
  }

  const gqlErrors =
    responseJson?.errors ||
    responseJson?.graphQLErrors ||
    responseJson?.body?.errors;
  const order =
    responseJson?.data?.orders?.edges?.[0]?.node ||
    responseJson?.body?.data?.orders?.edges?.[0]?.node ||
    null;
  if (!order) {
    if (gqlErrors) {
      const errorMessages = gqlErrors
        .map((e: any) => e.message)
        .filter(Boolean)
        .join(", ");
      if (errorMessages) {
        throw new Error(`GraphQL error: ${errorMessages}`);
      }
    }
    return null;
  }

  return {
    id: order.id,
    legacyResourceId: order.legacyResourceId,
    name: order.name ?? null,
    lineItems: order.lineItems?.edges?.map((edge: any) => ({
      id: edge.node.id,
      title: edge.node.title,
      quantity: edge.node.quantity,
    })) ?? [],
  };
}

export async function createRefundGraphQL(
  admin: AdminApiContext,
  input: {
    orderId: string;
    refundLineItems: Array<{ lineItemId: string; quantity: number }>;
    note?: string;
    notify?: boolean;
  }
): Promise<{ refundId: string | null; userErrors: string[] }> {
  const REFUND_CREATE_MUTATION = `
    mutation refundCreate($input: RefundCreateInput!) {
      refundCreate(input: $input) {
        refund {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await admin.graphql(REFUND_CREATE_MUTATION, {
    variables: {
      input: {
        orderId: input.orderId,
        refundLineItems: input.refundLineItems,
        note: input.note,
        notify: input.notify ?? false,
      },
    },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin API request failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    data?: {
      refundCreate?: {
        refund?: { id: string } | null;
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

  const userErrors = payload.data?.refundCreate?.userErrors || [];
  return {
    refundId: payload.data?.refundCreate?.refund?.id || null,
    userErrors: userErrors.map((e) => e.message),
  };
}

/**
 * Shopify Admin GraphQL API로 주문을 조회합니다.
 * Phase 5-6R: Rebuild를 위한 주문 조회
 * @param admin AdminApiContext
 * @param ordersFrom 주문 생성일 범위 시작 (YYYY-MM-DD)
 * @param ordersTo 주문 생성일 범위 종료 (YYYY-MM-DD)
 * @returns 주문 배열
 */
export async function fetchOrdersGraphQL(
  admin: any,
  ordersFrom: string,
  ordersTo: string
): Promise<ShopifyOrder[]> {
  const allOrders: ShopifyOrder[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  const logDebug = (payload: Record<string, unknown>): void => {
    if (process.env.DEBUG_BOOKING === "1") {
      console.log(JSON.stringify(payload));
    }
  };

  const GET_ORDERS_QUERY = `
    query getOrders($first: Int!, $after: String, $query: String!) {
      orders(first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            createdAt
            processedAt
            cancelledAt
            displayFinancialStatus
            legacyResourceId
            name
            lineItems(first: 250) {
              edges {
                node {
                  id
                  quantity
                  product {
                    id
                  }
                  variant {
                    id
                  }
                  title
                  customAttributes {
                    key
                    value
                  }
                }
              }
            }
          }
          cursor
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  // GraphQL query 문자열 생성
  // status:any AND created_at:>=ordersFrom AND created_at:<=ordersTo
  const query = `status:any created_at:>=${ordersFrom} created_at:<=${ordersTo}`;

  while (hasNextPage) {
    try {
      const variables: any = {
        first: 50,
        query,
      };

      if (cursor) {
        variables.after = cursor;
      }

      const response = await admin.graphql(GET_ORDERS_QUERY, {
        variables,
      });

      // 401 Unauthorized 응답 처리
      if (response.status === 401) {
        const errorText = await response.text();
        logDebug({
          message: "Shopify Admin API unauthorized",
          status: response.status,
          ordersFrom,
          ordersTo,
          cursor,
          error: errorText.substring(0, 200),
        });
        throw new Error(`Unauthorized (401): ${errorText.substring(0, 200)}`);
      }

      if (!response.ok) {
        const errorText = await response.text();
        logDebug({
          message: "Shopify Admin API error",
          status: response.status,
          ordersFrom,
          ordersTo,
          cursor,
          error: errorText.substring(0, 200),
        });
        throw new Error(`HTTP ${response.status}: ${errorText.substring(0, 200)}`);
      }

      const data = (await response.json()) as {
        data: OrdersQueryResult;
        errors?: Array<{ message: string }>;
      };

      if (data.errors && data.errors.length > 0) {
        logDebug({
          message: "Shopify Admin API GraphQL errors",
          ordersFrom,
          ordersTo,
          cursor,
          errors: data.errors.map((e) => e.message),
        });
        throw new Error(
          `GraphQL errors: ${data.errors.map((e) => e.message).join(", ")}`
        );
      }

      if (!data.data || !data.data.orders) {
        break;
      }

      const orders = data.data.orders.edges.map((edge) => edge.node);
      allOrders.push(...orders);

      hasNextPage = data.data.orders.pageInfo.hasNextPage;
      cursor = data.data.orders.pageInfo.endCursor;
    } catch (error) {
      if (error instanceof Error && error.message.includes("timeout")) {
        throw new Error("SHOPIFY_ADMIN_API_TIMEOUT");
      }
      throw new Error(
        `Failed to fetch orders: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return allOrders;
}

export interface GlobalBlackoutItem {
  id: string;
  date: string;
  note?: string;
  source: "manual" | "ics";
}

const GLOBAL_BLACKOUT_TYPE = "global_blackout";
const METAOBJECT_PAGE_SIZE = 250;

async function resolveAdminContext(params: {
  admin?: AdminApiContext;
  shop?: string;
}): Promise<AdminApiContext> {
  if (params.admin) {
    return params.admin;
  }
  if (!params.shop) {
    throw new Error("Shop is required to create Admin API client");
  }
  const admin = await getAdminApiClient(params.shop);
  if (!admin) {
    throw new Error("Shopify Admin API session not found");
  }
  return admin;
}

async function fetchMetaobjects(
  admin: AdminApiContext,
  query?: string
): Promise<Array<{ id: string; fields: Array<{ key: string; value: string }> }>> {
  const GET_METAOBJECTS_QUERY = `
    query getGlobalBlackouts($type: String!, $first: Int!, $after: String, $query: String) {
      metaobjects(type: $type, first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            fields { key value }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const nodes: Array<{ id: string; fields: Array<{ key: string; value: string }> }> = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(GET_METAOBJECTS_QUERY, {
      variables: {
        type: GLOBAL_BLACKOUT_TYPE,
        first: METAOBJECT_PAGE_SIZE,
        after: cursor,
        query,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Shopify Admin API request failed with status ${response.status}`
      );
    }

    const payload = (await response.json()) as {
      data?: {
        metaobjects?: {
          edges?: Array<{ node: { id: string; fields: Array<{ key: string; value: string }> } }>;
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(
        `GraphQL errors: ${payload.errors.map((e) => e.message).join(", ")}`
      );
    }

    const edges = payload.data?.metaobjects?.edges || [];
    for (const edge of edges) {
      nodes.push(edge.node);
    }

    hasNextPage = payload.data?.metaobjects?.pageInfo?.hasNextPage || false;
    cursor = payload.data?.metaobjects?.pageInfo?.endCursor || null;
  }

  return nodes;
}

async function fetchMetaobjectsWithFallback(
  admin: AdminApiContext,
  query?: string
): Promise<Array<{ id: string; fields: Array<{ key: string; value: string }> }>> {
  try {
    return await fetchMetaobjects(admin, query);
  } catch (error) {
    if (query) {
      return await fetchMetaobjects(admin, undefined);
    }
    throw error;
  }
}

function parseGlobalBlackout(
  node: { id: string; fields: Array<{ key: string; value: string }> }
): GlobalBlackoutItem | null {
  if (!node?.id || !node.fields) {
    return null;
  }

  const fieldMap: Record<string, string> = {};
  for (const field of node.fields) {
    fieldMap[field.key] = field.value;
  }

  const date = fieldMap.date;
  const source = fieldMap.source;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!date || !dateRegex.test(date)) {
    return null;
  }
  if (source !== "manual" && source !== "ics") {
    return null;
  }

  const note = fieldMap.note;
  return {
    id: node.id,
    date,
    ...(note ? { note } : {}),
    source,
  };
}

export async function listGlobalBlackouts(params: {
  shop?: string;
  admin?: AdminApiContext;
  from?: string;
  to?: string;
}): Promise<{ dates: string[]; items: GlobalBlackoutItem[] }> {
  const admin = await resolveAdminContext(params);
  const from = params.from;
  const to = params.to;
  const nodes = await fetchMetaobjectsWithFallback(admin, undefined);
  const parsed = nodes
    .map(parseGlobalBlackout)
    .filter((item): item is GlobalBlackoutItem => item !== null);

  const filtered = parsed.filter((item) => {
    if (from && item.date < from) {
      return false;
    }
    if (to && item.date > to) {
      return false;
    }
    return true;
  });

  const sorted = filtered.sort((a, b) => a.date.localeCompare(b.date));
  const items: GlobalBlackoutItem[] = [];
  const seenDates = new Set<string>();
  for (const item of sorted) {
    if (seenDates.has(item.date)) {
      continue;
    }
    seenDates.add(item.date);
    items.push(item);
  }

  const dates = items.map((item) => item.date);
  return { dates, items };
}

export async function findGlobalBlackoutByDate(params: {
  shop?: string;
  admin?: AdminApiContext;
  date: string;
}): Promise<GlobalBlackoutItem | null> {
  const admin = await resolveAdminContext(params);
  const query = `date:${params.date}`;
  const nodes = await fetchMetaobjectsWithFallback(admin, query);
  const parsed = nodes
    .map(parseGlobalBlackout)
    .filter((item): item is GlobalBlackoutItem => item !== null);
  const match = parsed.find((item) => item.date === params.date);
  if (match) {
    return match;
  }
  const fallbackNodes = await fetchMetaobjectsWithFallback(admin, undefined);
  const fallbackParsed = fallbackNodes
    .map(parseGlobalBlackout)
    .filter((item): item is GlobalBlackoutItem => item !== null);
  return fallbackParsed.find((item) => item.date === params.date) || null;
}

export async function listGlobalBlackoutRecordsByDate(params: {
  shop?: string;
  admin?: AdminApiContext;
  date: string;
}): Promise<GlobalBlackoutItem[]> {
  const admin = await resolveAdminContext(params);
  const query = `date:${params.date}`;
  const nodes = await fetchMetaobjectsWithFallback(admin, query);
  const parsed = nodes
    .map(parseGlobalBlackout)
    .filter((item): item is GlobalBlackoutItem => item !== null);
  if (parsed.some((item) => item.date === params.date)) {
    return parsed.filter((item) => item.date === params.date);
  }
  const fallbackNodes = await fetchMetaobjectsWithFallback(admin, undefined);
  const fallbackParsed = fallbackNodes
    .map(parseGlobalBlackout)
    .filter((item): item is GlobalBlackoutItem => item !== null);
  return fallbackParsed.filter((item) => item.date === params.date);
}

export async function createGlobalBlackout(params: {
  shop?: string;
  admin?: AdminApiContext;
  date: string;
  note?: string;
  source?: "manual" | "ics";
}): Promise<GlobalBlackoutItem> {
  const admin = await resolveAdminContext(params);
  const fields = [
    { key: "date", value: params.date },
    { key: "source", value: params.source ?? "manual" },
  ];
  if (params.note) {
    fields.push({ key: "note", value: params.note });
  }

  const CREATE_METAOBJECT_MUTATION = `
    mutation createGlobalBlackout($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject {
          id
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(CREATE_METAOBJECT_MUTATION, {
    variables: {
      metaobject: {
        type: GLOBAL_BLACKOUT_TYPE,
        fields,
      },
    },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin API request failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    data?: {
      metaobjectCreate?: {
        metaobject?: { id: string; fields: Array<{ key: string; value: string }> };
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

  const userErrors = payload.data?.metaobjectCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const node = payload.data?.metaobjectCreate?.metaobject;
  if (!node) {
    throw new Error("Metaobject creation failed");
  }

  const parsed = parseGlobalBlackout(node);
  if (!parsed) {
    throw new Error("Metaobject parsing failed");
  }

  return parsed;
}

export async function updateGlobalBlackoutNote(params: {
  shop?: string;
  admin?: AdminApiContext;
  id: string;
  note: string;
}): Promise<GlobalBlackoutItem> {
  const admin = await resolveAdminContext(params);
  const fields = [{ key: "note", value: params.note }];

  const UPDATE_METAOBJECT_MUTATION = `
    mutation updateGlobalBlackout($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject {
          id
          fields { key value }
        }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(UPDATE_METAOBJECT_MUTATION, {
    variables: {
      id: params.id,
      metaobject: { fields },
    },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin API request failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    data?: {
      metaobjectUpdate?: {
        metaobject?: { id: string; fields: Array<{ key: string; value: string }> };
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

  const userErrors = payload.data?.metaobjectUpdate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const node = payload.data?.metaobjectUpdate?.metaobject;
  if (!node) {
    throw new Error("Metaobject update failed");
  }

  const parsed = parseGlobalBlackout(node);
  if (!parsed) {
    throw new Error("Metaobject parsing failed");
  }

  return parsed;
}

export async function deleteGlobalBlackout(params: {
  shop?: string;
  admin?: AdminApiContext;
  id: string;
}): Promise<void> {
  const admin = await resolveAdminContext(params);
  const DELETE_METAOBJECT_MUTATION = `
    mutation deleteGlobalBlackout($id: ID!) {
      metaobjectDelete(id: $id) {
        deletedId
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(DELETE_METAOBJECT_MUTATION, {
    variables: { id: params.id },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin API request failed with status ${response.status}`
    );
  }

  const payload = (await response.json()) as {
    data?: {
      metaobjectDelete?: {
        deletedId?: string | null;
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

  const userErrors = payload.data?.metaobjectDelete?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }
}
