/**
 * Shop Metafield 캐시
 * shop → ShopBookingConfig 캐싱 (Redis/Memory, TTL 5-15분)
 */

import { createRequire } from "module";
import type { ShopBookingConfig } from "./shopMetafieldService";

const require = createRequire(import.meta.url);

/**
 * 캐시 항목
 */
interface CacheEntry {
  config: ShopBookingConfig;
  cachedAt: number;
}

/**
 * 캐시 저장소 인터페이스
 */
interface MetafieldCacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, value: CacheEntry, ttlSeconds: number): Promise<void>;
}

/**
 * In-memory 캐시 저장소 (개발용)
 */
class InMemoryMetafieldCacheStore implements MetafieldCacheStore {
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
class RedisMetafieldCacheStore implements MetafieldCacheStore {
  private client: any; // ioredis.Redis

  constructor(redisUrl: string) {
    // ESM 환경에서 ioredis 로드 (createRequire 사용)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require("ioredis");
      this.client = new Redis(redisUrl);
    } catch (requireError) {
      throw requireError;
    }
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
let cacheStore: MetafieldCacheStore | null = null;

/**
 * 캐시 저장소 인스턴스를 가져옵니다.
 */
function getCacheStore(): MetafieldCacheStore {
  if (cacheStore) {
    return cacheStore;
  }

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    try {
      cacheStore = new RedisMetafieldCacheStore(redisUrl);
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "Redis 연결 실패, in-memory 캐시로 폴백",
          error: error instanceof Error ? error.message : String(error),
        })
      );
      cacheStore = new InMemoryMetafieldCacheStore();
    }
  } else {
    cacheStore = new InMemoryMetafieldCacheStore();
    // 주기적으로 만료된 항목 정리 (in-memory만)
    if (typeof setInterval !== "undefined") {
      setInterval(() => {
        (cacheStore as InMemoryMetafieldCacheStore).cleanup();
      }, 5 * 60 * 1000); // 5분마다
    }
  }

  return cacheStore;
}

/**
 * 캐시 키 생성
 */
function getCacheKey(shop: string): string {
  return `metafield:shop:${shop}`;
}

/**
 * 캐시 TTL (초)
 */
function getCacheTTL(): number {
  const ttl = Number(process.env.SHOP_METAFIELD_CACHE_TTL_SEC);
  if (ttl && ttl > 0) {
    return ttl;
  }
  return 300; // 기본값 5분
}

/**
 * Shop Metafield를 캐시에서 조회합니다.
 * @param shop shop 도메인
 * @returns 캐시된 config 또는 null
 */
export async function getCachedShopMetafields(
  shop: string
): Promise<ShopBookingConfig | null> {
  const store = getCacheStore();
  const key = getCacheKey(shop);
  const cached = await store.get(key);

  if (!cached) {
    return null;
  }

  return cached.config;
}

/**
 * Shop Metafield를 캐시에 저장합니다.
 * @param shop shop 도메인
 * @param config Shop Booking Config
 */
export async function setCachedShopMetafields(
  shop: string,
  config: ShopBookingConfig
): Promise<void> {
  const store = getCacheStore();
  const key = getCacheKey(shop);
  const ttl = getCacheTTL();

  const entry: CacheEntry = {
    config,
    cachedAt: Date.now(),
  };

  await store.set(key, entry, ttl);
}

