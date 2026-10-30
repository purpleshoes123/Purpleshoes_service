/**
 * Variant 가격 캐시
 * Phase 5-6: productId → variant 가격 정보 캐싱 (Redis/Memory, TTL 10분)
 */

import { createRequire } from "module";
import type { VariantPrices } from "./variantPricingService";

const require = createRequire(import.meta.url);

/**
 * 캐시 항목
 */
interface CacheEntry {
  adultPrice: number;
  childPrice: number;
  infantPrice: number;
  variantIds: {
    adult?: string;
    child?: string;
    infant?: string;
  };
  cachedAt: number;
}

/**
 * 캐시 저장소 인터페이스
 */
interface PricingCacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: CacheEntry, ttlSeconds: number): Promise<void>;
}

/**
 * In-memory 캐시 저장소 (개발용)
 */
class InMemoryPricingCacheStore implements PricingCacheStore {
  private store = new Map<string, { value: CacheEntry; expiresAt: number }>();

  async get(key: string): Promise<CacheEntry | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    // 만료된 항목 제거
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

  /**
   * 만료된 항목 정리
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}

/**
 * Redis 캐시 저장소
 */
class RedisPricingCacheStore implements PricingCacheStore {
  private client: any; // ioredis.Redis

  constructor(redisUrl: string) {
    // ESM 환경에서 ioredis 로드 (createRequire 사용)
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

/**
 * 캐시 저장소 인스턴스
 */
let cacheStore: PricingCacheStore | null = null;

/**
 * 캐시 저장소 인스턴스를 가져옵니다.
 */
function getCacheStore(): PricingCacheStore {
  if (cacheStore) {
    return cacheStore;
  }

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    try {
      cacheStore = new RedisPricingCacheStore(redisUrl);
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Redis 연결 실패, in-memory 캐시로 폴백",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      cacheStore = new InMemoryPricingCacheStore();
    }
  } else {
    cacheStore = new InMemoryPricingCacheStore();
    // 주기적으로 만료된 항목 정리 (in-memory만)
    if (typeof setInterval !== "undefined") {
      setInterval(
        () => {
          (cacheStore as InMemoryPricingCacheStore).cleanup();
        },
        5 * 60 * 1000,
      ); // 5분마다
    }
  }

  return cacheStore;
}

/**
 * 캐시 키 생성
 */
function getCacheKey(productId: string): string {
  return `price:variant:${productId}`;
}

/**
 * 캐시 TTL (초)
 */
function getCacheTTL(): number {
  const ttl = Number(process.env.VARIANT_PRICE_CACHE_TTL_SEC);
  if (ttl && ttl > 0) {
    return ttl;
  }
  return 600; // 기본값 10분
}

/**
 * Variant 가격을 캐시에서 조회합니다.
 * @param productId Shopify product ID
 * @returns 캐시된 가격 정보 또는 null
 */
export async function getCachedVariantPrices(productId: string): Promise<VariantPrices | null> {
  const store = getCacheStore();
  const key = getCacheKey(productId);
  const cached = await store.get(key);

  if (!cached) {
    return null;
  }

  // CacheEntry를 VariantPrices로 변환
  return {
    adultPrice: cached.adultPrice,
    childPrice: cached.childPrice,
    infantPrice: cached.infantPrice,
    variantIds: cached.variantIds,
  };
}

/**
 * Variant 가격을 캐시에 저장합니다.
 * @param productId Shopify product ID
 * @param prices 가격 정보
 */
export async function setCachedVariantPrices(
  productId: string,
  prices: VariantPrices,
): Promise<void> {
  const store = getCacheStore();
  const key = getCacheKey(productId);
  const ttl = getCacheTTL();

  const entry: CacheEntry = {
    ...prices,
    cachedAt: Date.now(),
  };

  await store.set(key, entry, ttl);
}
