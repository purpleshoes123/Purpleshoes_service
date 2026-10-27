import { getCouponRedisClient } from "~/lib/coupons/redisClient";
import { normalizeShopDomain } from "~/lib/shopifySession";
import {
  instagramConnectionKey,
  instagramDebugLastSyncKey,
  instagramMediaCacheKey,
  instagramOAuthStateKey,
} from "~/lib/instagram/keys";
import type {
  InstagramConnection,
  InstagramMediaResponseData,
  InstagramOAuthStatePayload,
  InstagramSyncDebug,
} from "~/lib/instagram/types";

type ExpiringValue<T> = {
  value: T;
  expiresAtMs: number;
};

const connectionMemory = new Map<string, InstagramConnection>();
const oauthStateMemory = new Map<string, ExpiringValue<InstagramOAuthStatePayload>>();
const mediaCacheMemory = new Map<string, ExpiringValue<InstagramMediaResponseData>>();
const debugMemory = new Map<string, InstagramSyncDebug>();

function nowMs(): number {
  return Date.now();
}

function normalizeShop(shop: string): string {
  const normalized = normalizeShopDomain(shop);
  if (!normalized) {
    return "";
  }
  if (normalized.includes(".")) {
    return normalized;
  }
  return `${normalized}.myshopify.com`;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function cleanupExpiredMemory<T>(map: Map<string, ExpiringValue<T>>): void {
  const current = nowMs();
  for (const [key, entry] of map.entries()) {
    if (entry.expiresAtMs <= current) {
      map.delete(key);
    }
  }
}

async function getRedisClient(): Promise<any | null> {
  return getCouponRedisClient();
}

export async function saveInstagramOAuthState(
  state: string,
  payload: InstagramOAuthStatePayload,
  ttlSec: number
): Promise<void> {
  const key = instagramOAuthStateKey(state);
  const redis = await getRedisClient();
  const raw = JSON.stringify(payload);

  if (redis) {
    await redis.set(key, raw, "EX", ttlSec);
    return;
  }

  oauthStateMemory.set(key, {
    value: payload,
    expiresAtMs: nowMs() + ttlSec * 1000,
  });
}

export async function consumeInstagramOAuthState(
  state: string
): Promise<InstagramOAuthStatePayload | null> {
  const key = instagramOAuthStateKey(state);
  const redis = await getRedisClient();

  if (redis) {
    const result = await redis.multi().get(key).del(key).exec();
    const raw = Array.isArray(result) ? result[0]?.[1] : null;
    return parseJson<InstagramOAuthStatePayload>(
      typeof raw === "string" ? raw : null
    );
  }

  cleanupExpiredMemory(oauthStateMemory);
  const entry = oauthStateMemory.get(key);
  if (!entry) {
    return null;
  }
  oauthStateMemory.delete(key);
  return entry.value;
}

export async function getInstagramConnection(
  shopRaw: string
): Promise<InstagramConnection | null> {
  const shop = normalizeShop(shopRaw);
  if (!shop) return null;

  const key = instagramConnectionKey(shop);
  const redis = await getRedisClient();

  if (redis) {
    const raw = await redis.get(key);
    return parseJson<InstagramConnection>(raw);
  }

  return connectionMemory.get(key) || null;
}

export async function setInstagramConnection(
  connection: InstagramConnection
): Promise<void> {
  const shop = normalizeShop(connection.shop);
  if (!shop) {
    throw new Error("Invalid shop");
  }

  const key = instagramConnectionKey(shop);
  const normalizedConnection: InstagramConnection = {
    ...connection,
    shop,
  };

  const redis = await getRedisClient();
  const raw = JSON.stringify(normalizedConnection);

  if (redis) {
    await redis.set(key, raw);
    return;
  }

  connectionMemory.set(key, normalizedConnection);
}

export async function clearInstagramConnection(shopRaw: string): Promise<void> {
  const shop = normalizeShop(shopRaw);
  if (!shop) return;

  const key = instagramConnectionKey(shop);
  const redis = await getRedisClient();

  if (redis) {
    await redis.del(key);
    return;
  }

  connectionMemory.delete(key);
}

export async function setInstagramMediaCache(params: {
  shop: string;
  limit: number;
  after?: string;
  includeReels: boolean;
  data: InstagramMediaResponseData;
  ttlSec: number;
}): Promise<void> {
  const shop = normalizeShop(params.shop);
  if (!shop) return;

  const key = instagramMediaCacheKey({
    shop,
    limit: params.limit,
    after: params.after,
    includeReels: params.includeReels,
  });

  const redis = await getRedisClient();
  const raw = JSON.stringify(params.data);

  if (redis) {
    await redis.set(key, raw, "EX", params.ttlSec);
    return;
  }

  mediaCacheMemory.set(key, {
    value: params.data,
    expiresAtMs: nowMs() + params.ttlSec * 1000,
  });
}

export async function getInstagramMediaCache(params: {
  shop: string;
  limit: number;
  after?: string;
  includeReels: boolean;
}): Promise<InstagramMediaResponseData | null> {
  const shop = normalizeShop(params.shop);
  if (!shop) return null;

  const key = instagramMediaCacheKey({
    shop,
    limit: params.limit,
    after: params.after,
    includeReels: params.includeReels,
  });

  const redis = await getRedisClient();

  if (redis) {
    const raw = await redis.get(key);
    return parseJson<InstagramMediaResponseData>(raw);
  }

  cleanupExpiredMemory(mediaCacheMemory);
  const entry = mediaCacheMemory.get(key);
  return entry?.value || null;
}

export async function setInstagramSyncDebug(params: {
  shop: string;
  debug: InstagramSyncDebug;
}): Promise<void> {
  const shop = normalizeShop(params.shop);
  if (!shop) return;

  const key = instagramDebugLastSyncKey(shop);
  const redis = await getRedisClient();
  const raw = JSON.stringify(params.debug);

  if (redis) {
    await redis.set(key, raw);
    return;
  }

  debugMemory.set(key, params.debug);
}

export async function getInstagramSyncDebug(
  shopRaw: string
): Promise<InstagramSyncDebug | null> {
  const shop = normalizeShop(shopRaw);
  if (!shop) return null;

  const key = instagramDebugLastSyncKey(shop);
  const redis = await getRedisClient();

  if (redis) {
    const raw = await redis.get(key);
    return parseJson<InstagramSyncDebug>(raw);
  }

  return debugMemory.get(key) || null;
}

export async function clearInstagramMediaCacheForShop(
  shopRaw: string
): Promise<void> {
  const shop = normalizeShop(shopRaw);
  if (!shop) return;

  const redis = await getRedisClient();
  if (redis) {
    let cursor = "0";
    const pattern = `instagram:media:${shop}:*`;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
      cursor = next;
      if (Array.isArray(keys) && keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
    return;
  }

  for (const key of mediaCacheMemory.keys()) {
    if (key.startsWith(`instagram:media:${shop}:`)) {
      mediaCacheMemory.delete(key);
    }
  }
}

export function resetInstagramMemoryStoreForTests(): void {
  connectionMemory.clear();
  oauthStateMemory.clear();
  mediaCacheMemory.clear();
  debugMemory.clear();
}
