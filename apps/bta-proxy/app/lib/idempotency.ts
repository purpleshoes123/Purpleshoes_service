/**
 * Idempotency 저장소 인터페이스
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

export interface IdempotencyStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/**
 * In-memory idempotency 저장소 (개발용)
 */
class InMemoryIdempotencyStore implements IdempotencyStore {
  private store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
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

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
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
 * Redis idempotency 저장소
 */
class RedisIdempotencyStore implements IdempotencyStore {
  private client: import("ioredis").Redis;

  constructor(redisUrl: string) {
    // ESM 환경에서 ioredis 로드 (createRequire 사용)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require("ioredis");
    this.client = new Redis(redisUrl);
  }

  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.setex(key, ttlSeconds, value);
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * Idempotency 저장소 인스턴스 생성
 */
let idempotencyStore: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  const multiNode = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
  if (multiNode && !process.env.REDIS_URL) {
    throw new Error("Multi-node idempotency requires shared Redis; memory fallback is disabled.");
  }
  if (idempotencyStore) {
    return idempotencyStore;
  }

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    try {
      idempotencyStore = new RedisIdempotencyStore(redisUrl);
    } catch (error) {
      if (multiNode) {
        throw new Error("Shared idempotency store initialization failed; memory fallback is disabled.");
      }
      console.warn(
        JSON.stringify({
          message: "Redis 연결 실패, in-memory 저장소로 폴백",
        })
      );
      idempotencyStore = new InMemoryIdempotencyStore();
    }
  } else {
    idempotencyStore = new InMemoryIdempotencyStore();
    // 주기적으로 만료된 항목 정리 (in-memory만)
    if (typeof setInterval !== "undefined") {
      setInterval(() => {
        (idempotencyStore as InMemoryIdempotencyStore).cleanup();
      }, 5 * 60 * 1000); // 5분마다
    }
  }

  return idempotencyStore;
}

/**
 * Idempotency 키 생성
 */
export function getIdempotencyKey(clientRequestId: string): string {
  return `idempo:${clientRequestId}`;
}

/**
 * Idempotency TTL (10분)
 */
export const IDEMPOTENCY_TTL_SECONDS = 10 * 60;
