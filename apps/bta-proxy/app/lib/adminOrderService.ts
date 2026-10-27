import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { createRequire } from "module";
import {
  fetchOrderSummaryByQuery,
  fetchOrderSummaryGraphQL,
  getAdminApiClient,
  fetchOrderRefundInfoGraphQL,
  fetchOrderRefundInfoByQuery,
  type ShopifyOrderRefundInfo,
  type ShopifyOrderSummary,
} from "~/lib/shopifyAdmin";

const require = createRequire(import.meta.url);

export type OrderSummary = {
  orderId: string;
  name?: string | null;
  title?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  processedAt?: string | null;
  cancelledAt?: string | null;
  customer?: {
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  adminUrl?: string | null;
  legacyResourceId?: string | number | null;
};

type CacheValue = OrderSummary | OrderRefundInfo | null;

export type OrderLineItem = {
  lineItemId: string;
  title: string;
  quantity: number;
};

export type OrderRefundInfo = {
  orderId: string;
  orderGid: string;
  name?: string | null;
  legacyResourceId?: string | number | null;
  lineItems: OrderLineItem[];
  adminUrl?: string | null;
};

interface OrderSummaryCacheStore {
  get(key: string): Promise<CacheValue | undefined>;
  set(key: string, value: CacheValue, ttlSeconds: number): Promise<void>;
}

class InMemoryOrderSummaryCacheStore implements OrderSummaryCacheStore {
  private store = new Map<string, { value: CacheValue; expiresAt: number }>();

  async get(key: string): Promise<CacheValue | undefined> {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: CacheValue,
    ttlSeconds: number
  ): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }
}

class RedisOrderSummaryCacheStore implements OrderSummaryCacheStore {
  private client: any; // ioredis.Redis

  constructor(redisUrl: string) {
    const Redis = require("ioredis");
    this.client = new Redis(redisUrl);
  }

  async get(key: string): Promise<CacheValue | undefined> {
    const cached = await this.client.get(key);
    if (!cached) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(cached) as { value: CacheValue };
      return parsed.value;
    } catch {
      return undefined;
    }
  }

  async set(
    key: string,
    value: CacheValue,
    ttlSeconds: number
  ): Promise<void> {
    await this.client.setex(key, ttlSeconds, JSON.stringify({ value }));
  }
}

let cacheStore: OrderSummaryCacheStore | null = null;
const ORDER_SUMMARY_TTL_SEC = 60;
const ORDER_REFUND_TTL_SEC = 60;

function getCacheStore(): OrderSummaryCacheStore {
  if (cacheStore) {
    return cacheStore;
  }
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      cacheStore = new RedisOrderSummaryCacheStore(redisUrl);
    } catch {
      cacheStore = new InMemoryOrderSummaryCacheStore();
    }
  } else {
    cacheStore = new InMemoryOrderSummaryCacheStore();
  }
  return cacheStore;
}

function buildSearchQueries(orderId: string): string[] {
  const normalized = orderId.replace(/^#/, "");
  const queries: string[] = [];
  if (/^\d+$/.test(normalized)) {
    queries.push(`order_number:${normalized}`);
    queries.push(`name:#${normalized}`);
    queries.push(`name:${normalized}`);
  } else if (normalized) {
    queries.push(`name:${normalized}`);
  }
  return queries.map((q) => `status:any ${q}`);
}

function buildCustomerName(customer?: {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
} | null): string | null {
  if (!customer) return null;
  if (customer.displayName && customer.displayName.trim()) {
    return customer.displayName.trim();
  }
  const name = [customer.firstName, customer.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || null;
}

function extractLegacyOrderId(order: ShopifyOrderSummary): string | null {
  if (order.legacyResourceId) {
    return String(order.legacyResourceId);
  }
  if (order.id && order.id.startsWith("gid://")) {
    const match = /gid:\/\/shopify\/Order\/(\d+)/.exec(order.id);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function buildAdminOrderUrl(shop: string, order: ShopifyOrderSummary): string | null {
  const legacyId = extractLegacyOrderId(order);
  if (!legacyId) {
    return null;
  }
  return `https://${shop}/admin/orders/${legacyId}`;
}

function mapOrderSummary(
  shop: string,
  orderId: string,
  order: ShopifyOrderSummary
): OrderSummary {
  const customerName = buildCustomerName(order.customer || undefined);
  const addressName =
    order.billingAddress?.name ||
    order.shippingAddress?.name ||
    null;
  const customerEmail = order.customer?.email ?? order.email ?? null;
  const customerPhone =
    order.customer?.phone ??
    order.phone ??
    order.billingAddress?.phone ??
    order.shippingAddress?.phone ??
    null;
  const resolvedName = customerName || addressName;
  const customerPayload =
    resolvedName || customerEmail || customerPhone
      ? {
          name: resolvedName,
          email: customerEmail,
          phone: customerPhone,
        }
      : null;
  return {
    orderId,
    name: order.name ?? null,
    title: order.lineItemTitle ?? null,
    displayFinancialStatus: order.displayFinancialStatus ?? null,
    displayFulfillmentStatus: order.displayFulfillmentStatus ?? null,
    processedAt: order.processedAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    customer: customerPayload,
    adminUrl: buildAdminOrderUrl(shop, order),
    legacyResourceId: order.legacyResourceId ?? null,
  };
}

export async function getOrderSummary(params: {
  shop: string;
  orderId: string;
  admin?: AdminApiContext;
}): Promise<OrderSummary | null> {
  const cacheKey = `${params.shop}:${params.orderId}`;
  const store = getCacheStore();
  const cached = await store.get(cacheKey);
  if (cached !== undefined) {
    return cached as OrderSummary | null;
  }

  const tryFetch = async (
    admin: AdminApiContext | null
  ): Promise<ShopifyOrderSummary | null> => {
    if (!admin) return null;
    let order: ShopifyOrderSummary | null = null;
    try {
      order = await fetchOrderSummaryGraphQL(admin, params.orderId);
    } catch {
      order = null;
    }
    if (order) {
      return order;
    }
    const queries = buildSearchQueries(params.orderId);
    for (const query of queries) {
      try {
        const byQuery = await fetchOrderSummaryByQuery(admin, query);
        if (byQuery) {
          return byQuery;
        }
      } catch {
        // ignore query failure and continue
      }
    }
    return null;
  };

  let order = await tryFetch(params.admin || null);
  if (!order) {
    const fallbackAdmin = await getAdminApiClient(params.shop);
    order = await tryFetch(fallbackAdmin);
  }

  const summary = order
    ? mapOrderSummary(params.shop, params.orderId, order)
    : null;
  await store.set(cacheKey, summary, ORDER_SUMMARY_TTL_SEC);
  if (!summary && process.env.DEBUG_BOOKING === "1") {
    const queries = buildSearchQueries(params.orderId);
    console.log(
      JSON.stringify({
        message: "Order summary not found",
        shop: params.shop,
        orderId: params.orderId,
        queries,
      })
    );
  }
  return summary;
}

function mapRefundInfo(
  shop: string,
  orderId: string,
  order: ShopifyOrderRefundInfo
): OrderRefundInfo {
  const legacyId = order.legacyResourceId ? String(order.legacyResourceId) : null;
  const adminUrl = legacyId
    ? `https://${shop}/admin/orders/${legacyId}`
    : null;

  return {
    orderId,
    orderGid: order.id,
    name: order.name ?? null,
    legacyResourceId: order.legacyResourceId ?? null,
    lineItems:
      order.lineItems?.map((item) => ({
        lineItemId: item.id,
        title: item.title,
        quantity: item.quantity,
      })) ?? [],
    adminUrl,
  };
}

export async function getOrderRefundInfo(params: {
  shop: string;
  orderId: string;
  admin?: AdminApiContext;
}): Promise<OrderRefundInfo | null> {
  const cacheKey = `refund:${params.shop}:${params.orderId}`;
  const store = getCacheStore();
  const cached = await store.get(cacheKey);
  if (cached !== undefined) {
    return cached as OrderRefundInfo | null;
  }

  const tryFetch = async (
    admin: AdminApiContext | null
  ): Promise<ShopifyOrderRefundInfo | null> => {
    if (!admin) return null;
    let order: ShopifyOrderRefundInfo | null = null;
    try {
      order = await fetchOrderRefundInfoGraphQL(admin, params.orderId);
    } catch {
      order = null;
    }
    if (order) {
      return order;
    }

    for (const query of buildSearchQueries(params.orderId)) {
      try {
        order = await fetchOrderRefundInfoByQuery(admin, query);
      } catch {
        order = null;
      }
      if (order) {
        return order;
      }
    }
    return null;
  };

  let admin = params.admin || null;
  if (!admin) {
    admin = await getAdminApiClient(params.shop);
  }

  const result = admin ? await tryFetch(admin) : null;
  const mapped = result ? mapRefundInfo(params.shop, params.orderId, result) : null;
  await store.set(cacheKey, mapped, ORDER_REFUND_TTL_SEC);
  return mapped;
}

export function __private__mapOrderSummary(
  shop: string,
  orderId: string,
  order: ShopifyOrderSummary
): OrderSummary {
  return mapOrderSummary(shop, orderId, order);
}
