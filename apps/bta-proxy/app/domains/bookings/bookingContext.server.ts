import { randomUUID } from "node:crypto";
import { getRedisBookingClient } from "~/domains/bookings/bookingStore";
import { getAdminApiClient } from "~/lib/shopifyAdmin";

const CONTEXT_PREFIX = "bctx_";
const CONTEXT_TTL_SECONDS = 30 * 60;
const memoryContexts = new Map<string, { productId: string; shop: string; expiresAt: number }>();

function contextKey(token: string) {
  return `booking-context:${token}`;
}

function productHandleFromReferer(request: Request): string | null {
  const referer = request.headers.get("referer");
  if (!referer) {
    return null;
  }

  try {
    const url = new URL(referer);
    const match = url.pathname.match(/^\/products\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function findProductIdByHandle(shop: string, handle: string): Promise<string | null> {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }

  const response = await admin.graphql(
    `#graphql
      query BookingContextProduct($handle: String!) {
        productByHandle(handle: $handle) {
          id
          legacyResourceId
        }
      }
    `,
    { variables: { handle } },
  );
  const payload = (await response.json()) as {
    data?: { productByHandle?: { id?: string; legacyResourceId?: string | number | null } | null };
  };
  const product = payload.data?.productByHandle;
  if (!product) {
    return null;
  }

  return (
    String(product.legacyResourceId || product.id?.replace("gid://shopify/Product/", "") || "") ||
    null
  );
}

export async function issueBookingContext(request: Request, shop: string): Promise<string | null> {
  const handle = productHandleFromReferer(request);
  if (!handle) {
    return null;
  }

  const productId = await findProductIdByHandle(shop, handle);
  if (!productId) {
    return null;
  }

  return createBookingContext(productId, shop);
}

export async function createBookingContext(productId: string, shop: string): Promise<string> {
  const token = `${CONTEXT_PREFIX}${randomUUID().replace(/-/g, "")}`;
  const record = { productId, shop };
  const redis = getRedisBookingClient();

  if (redis) {
    await redis.set(contextKey(token), JSON.stringify(record), "EX", CONTEXT_TTL_SECONDS);
  } else {
    memoryContexts.set(token, { ...record, expiresAt: Date.now() + CONTEXT_TTL_SECONDS * 1000 });
  }

  return token;
}

/**
 * Resolves a short-lived public booking reference to the internal Shopify product ID.
 * Raw IDs remain temporarily supported for pages served before the paired theme rollout.
 */
export async function resolveBookingProductId(
  reference: string,
  shop: string,
): Promise<string | null> {
  if (!reference.startsWith(CONTEXT_PREFIX)) {
    return reference;
  }

  const redis = getRedisBookingClient();
  if (redis) {
    const raw = await redis.get(contextKey(reference));
    if (!raw) {
      return null;
    }
    try {
      const record = JSON.parse(raw) as { productId?: string; shop?: string };
      return record.shop === shop && record.productId ? record.productId : null;
    } catch {
      return null;
    }
  }

  const record = memoryContexts.get(reference);
  if (!record || record.expiresAt <= Date.now()) {
    memoryContexts.delete(reference);
    return null;
  }
  return record.shop === shop ? record.productId : null;
}
