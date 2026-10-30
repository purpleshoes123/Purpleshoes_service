/**
 * Tier Variant 가격 캐시
 * productId → Tier Variant Table 캐싱 (Redis/Memory, TTL 10분)
 */

import { createRequire } from "module";
import type { TierVariantTable } from "./tierVariantPricingService";
import { normalizeShopDomain } from "../../lib/shopifySession";

const require = createRequire(import.meta.url);

interface CacheEntry extends TierVariantTable {
  cachedAt: number;
}

interface TierPricingCacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: CacheEntry, ttlSeconds: number): Promise<void>;
}

class InMemoryTierPricingCacheStore implements TierPricingCacheStore {
  private store = new Map<string, { value: CacheEntry; expiresAt: number }>();

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: CacheEntry, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

class RedisTierPricingCacheStore implements TierPricingCacheStore {
  private client: any;

  constructor(redisUrl: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    this.client = new Redis(redisUrl);
  }

  async get(key: string): Promise<CacheEntry | null> {
    const cached = await this.client.get(key);
    if (!cached) {
      return null;
    }
    try {
      return JSON.parse(cached) as CacheEntry;
    } catch {
      return null;
    }
  }

  async set(key: string, value: CacheEntry, ttlSeconds: number): Promise<void> {
    await this.client.setex(key, ttlSeconds, JSON.stringify(value));
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

let cacheStore: TierPricingCacheStore | null = null;

function getCacheStore(): TierPricingCacheStore {
  if (cacheStore) {
    return cacheStore;
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      cacheStore = new RedisTierPricingCacheStore(redisUrl);
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Redis 연결 실패, in-memory 캐시로 폴백",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      cacheStore = new InMemoryTierPricingCacheStore();
    }
  } else {
    cacheStore = new InMemoryTierPricingCacheStore();
    if (typeof setInterval !== "undefined") {
      setInterval(
        () => {
          (cacheStore as InMemoryTierPricingCacheStore).cleanup();
        },
        5 * 60 * 1000,
      );
    }
  }

  return cacheStore;
}

function getCacheKey(shop: string, productId: string): string {
  // shop 포함 키로 캐시 오염 방지
  const normalizedShop = normalizeShopDomain(shop);
  return `price:tier-variant:${normalizedShop}:${productId}`;
}

function getCacheTTL(): number {
  const ttl = Number(process.env.VARIANT_PRICE_CACHE_TTL_SEC);
  if (ttl && ttl > 0) {
    return ttl;
  }
  return 300;
}

export async function getCachedTierVariantTable(
  shop: string,
  productId: string,
): Promise<TierVariantTable | null> {
  const store = getCacheStore();
  const key = getCacheKey(shop, productId);
  const cached = await store.get(key);
  if (!cached) {
    return null;
  }
  return {
    byTier: cached.byTier,
    byVariantId: cached.byVariantId,
  };
}

export async function setCachedTierVariantTable(
  shop: string,
  productId: string,
  table: TierVariantTable,
): Promise<void> {
  const store = getCacheStore();
  const key = getCacheKey(shop, productId);
  const ttl = getCacheTTL();
  const entry: CacheEntry = {
    ...table,
    cachedAt: Date.now(),
  };
  await store.set(key, entry, ttl);
}
