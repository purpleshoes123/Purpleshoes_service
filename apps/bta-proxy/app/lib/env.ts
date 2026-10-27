import { z } from "zod";

/**
 * SSOT 10장: 환경변수 스키마
 */

const envSchema = z.object({
  // 필수 환경변수
  PORT: z.string().transform(Number),
  NODE_ENV: z.enum(["development", "production", "test"]),
  SHOPIFY_API_SECRET: z.string().min(1, "SHOPIFY_API_SECRET is required"),

  // 선택 환경변수
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .optional()
    .default("info"),
  REDIS_URL: z.string().url().optional(),
  DATABASE_URL: z.string().url().optional(),
  RATE_LIMIT_PER_MIN: z.string().transform(Number).optional().default("60"),
  STOREFRONT_RATE_LIMIT_V2_MODE: z.string().optional().default("off"),
  STOREFRONT_RATE_LIMIT_WINDOW_SEC: z
    .string()
    .transform(Number)
    .optional()
    .default("60"),
  STOREFRONT_RATE_LIMIT_MYPAGE_READ_PER_MIN: z
    .string()
    .transform(Number)
    .optional()
    .default("120"),
  STOREFRONT_RATE_LIMIT_SIGNED_URL_PER_MIN: z
    .string()
    .transform(Number)
    .optional()
    .default("20"),
  STOREFRONT_RATE_LIMIT_MYPAGE_WRITE_PER_MIN: z
    .string()
    .transform(Number)
    .optional()
    .default("30"),
  STOREFRONT_RATE_LIMIT_REDIS_TIMEOUT_MS: z
    .string()
    .transform(Number)
    .optional()
    .default("300"),
  STOREFRONT_RATE_LIMIT_REDIS_CIRCUIT_COOLDOWN_MS: z
    .string()
    .transform(Number)
    .optional()
    .default("15000"),

  // Booking Store 환경변수
  BOOKING_STORE_TYPE: z
    .enum(["redis", "postgres", "memory"])
    .optional()
    .default("memory"),
  STORE_TIMEOUT_MS: z.string().transform(Number).optional().default("2000"),
  HOLD_TTL_SEC: z.string().transform(Number).optional().default("600"),

  // Pricing Engine 환경변수
  BASE_PRICE_DEFAULT: z.string().transform(Number).optional(),
  TIER_ENABLED: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),
  SERVICE_FEE_DEFAULT: z.string().transform(Number).optional(),
  PRICING_RULES_JSON: z.string().optional(),

  // Blackout 환경변수
  BLACKOUT_DATES_JSON: z.string().optional(),

  // Guide Pool 환경변수
  GUIDE_POOL_CAPACITY_DEFAULT: z.string().transform(Number).optional(),

  // Phase 5-6R: 내부 Rebuild 환경변수
  INTERNAL_TOKEN: z.string().optional(),
  REBUILD_ALLOWED_SHOPS: z.string().optional(),
  REBUILD_LOCK_TTL_SEC: z.string().transform(Number).optional().default("600"),

  // Phase X: 부팅 시 자동 Rebuild 환경변수
  REBUILD_AUTO_ON_STARTUP: z.string().optional(),
  REBUILD_AUTO_MODE: z.enum(["upsert", "replace"]).optional().default("upsert"),
  REBUILD_AUTO_DAYS: z.string().transform(Number).optional().default("30"),
  REBUILD_AUTO_TO_OFFSET_DAYS: z
    .string()
    .transform(Number)
    .optional()
    .default("1"),
  REBUILD_AUTO_IF_EMPTY: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("true"),
  REBUILD_AUTO_SHOPS: z.string().optional(), // 쉼표 구분 shop 목록

  // Phase 4: Hold release allowlist
  HOLD_RELEASE_VOID_ALLOW_TOPICS: z.string().optional(),
  HOLD_RELEASE_CANCEL_FORCE: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),
  INTERNAL_RECONCILE_LOCK_TTL_SEC: z
    .string()
    .transform(Number)
    .optional()
    .default("600"),

  // Metafield 캐시 환경변수
  PRODUCT_METAFIELD_CACHE_TTL_SEC: z
    .string()
    .transform(Number)
    .optional()
    .default("300"),
  SHOP_METAFIELD_CACHE_TTL_SEC: z
    .string()
    .transform(Number)
    .optional()
    .default("300"),
  METAFIELD_FALLBACK_ENABLED: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),

  // Coupons/Discounts 환경변수
  ADMIN_API_KEY: z.string().optional(),
  INTERNAL_EVENT_TOKEN: z.string().optional(),
  SQUEEZE_EVENT_TOKEN: z.string().optional(),
  SHOPIFY_STOREFRONT_TOKEN: z.string().optional(),
  SHOPIFY_STOREFRONT_API_VERSION: z.string().optional(),
  COUPON_CART_ADAPTER: z.enum(["mock", "storefront"]).optional(),
  COUPON_SHARE_INTENT_TTL_SEC: z
    .string()
    .transform(Number)
    .optional()
    .default("3600"),
  COUPON_ALLOW_ENTITLED_OVERRIDE: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),
  COUPON_ALLOW_EXTRA10_WITHOUT_CODE: z
    .string()
    .transform((val) => val === "true")
    .optional()
    .default("false"),
  COUPON_TOUR_COLLECTION_HANDLES: z.string().optional(),
  COUPON_TOUR_TAGS: z.string().optional(),
  COUPON_TOUR_PRODUCT_TYPES: z.string().optional(),
  COUPON_EXTENSION_TAGS: z.string().optional(),
  COUPON_EXTENSION_PRODUCT_TYPES: z.string().optional(),
  COUPON_EXTENSION_COLLECTION_HANDLES: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let validatedEnv: Env | null = null;
let envLogged = false;

/**
 * 민감한 환경변수 값을 마스킹합니다.
 */
function maskSensitiveValue(key: string, value: string | undefined): string {
  if (!value) return value || "";

  // URL에서 비밀번호 부분 마스킹 (redis://user:password@host 또는 postgres://user:password@host)
  if (key === "REDIS_URL" || key === "DATABASE_URL") {
    try {
      const url = new URL(value);
      if (url.password) {
        url.password = "***";
        return url.toString();
      }
    } catch {
      // URL 파싱 실패 시 전체 마스킹
      return "***";
    }
  }

  return value;
}

/**
 * 환경변수를 로그로 출력합니다 (URL 비밀번호는 마스킹).
 */
function logEnvVars(): void {
  if (envLogged) return;
  envLogged = true;

  console.log("=".repeat(60));
  console.log("환경변수 로드 완료");
  console.log("=".repeat(60));

  const envVars = {
    // 필수 환경변수
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_API_SECRET:
      process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_APP_SECRET,
    // 선택 환경변수
    LOG_LEVEL: process.env.LOG_LEVEL || "info (default)",
    REDIS_URL: maskSensitiveValue("REDIS_URL", process.env.REDIS_URL),
    DATABASE_URL: maskSensitiveValue("DATABASE_URL", process.env.DATABASE_URL),
    RATE_LIMIT_PER_MIN: process.env.RATE_LIMIT_PER_MIN || "60 (default)",
    STOREFRONT_RATE_LIMIT_V2_MODE:
      process.env.STOREFRONT_RATE_LIMIT_V2_MODE || "off (default)",
    STOREFRONT_RATE_LIMIT_WINDOW_SEC:
      process.env.STOREFRONT_RATE_LIMIT_WINDOW_SEC || "60 (default)",
    STOREFRONT_RATE_LIMIT_MYPAGE_READ_PER_MIN:
      process.env.STOREFRONT_RATE_LIMIT_MYPAGE_READ_PER_MIN || "120 (default)",
    STOREFRONT_RATE_LIMIT_SIGNED_URL_PER_MIN:
      process.env.STOREFRONT_RATE_LIMIT_SIGNED_URL_PER_MIN || "20 (default)",
    STOREFRONT_RATE_LIMIT_MYPAGE_WRITE_PER_MIN:
      process.env.STOREFRONT_RATE_LIMIT_MYPAGE_WRITE_PER_MIN || "30 (default)",
    STOREFRONT_RATE_LIMIT_REDIS_TIMEOUT_MS:
      process.env.STOREFRONT_RATE_LIMIT_REDIS_TIMEOUT_MS || "300 (default)",
    STOREFRONT_RATE_LIMIT_REDIS_CIRCUIT_COOLDOWN_MS:
      process.env.STOREFRONT_RATE_LIMIT_REDIS_CIRCUIT_COOLDOWN_MS ||
      "15000 (default)",
    // Booking Store 환경변수
    BOOKING_STORE_TYPE: process.env.BOOKING_STORE_TYPE || "memory (default)",
    STORE_TIMEOUT_MS: process.env.STORE_TIMEOUT_MS || "2000 (default)",
    HOLD_TTL_SEC: process.env.HOLD_TTL_SEC || "600 (default)",
    // Pricing Engine 환경변수
    BASE_PRICE_DEFAULT: process.env.BASE_PRICE_DEFAULT || "(not set)",
    TIER_ENABLED: process.env.TIER_ENABLED || "false (default)",
    SERVICE_FEE_DEFAULT: process.env.SERVICE_FEE_DEFAULT || "(not set)",
    PRICING_RULES_JSON: process.env.PRICING_RULES_JSON ? "(set)" : "(not set)",
    // Blackout 환경변수
    BLACKOUT_DATES_JSON: process.env.BLACKOUT_DATES_JSON
      ? "(set)"
      : "(not set)",
    // Guide Pool 환경변수
    GUIDE_POOL_CAPACITY_DEFAULT:
      process.env.GUIDE_POOL_CAPACITY_DEFAULT || "(not set)",
    // Phase 5-6R: 내부 Rebuild 환경변수
    INTERNAL_TOKEN: process.env.INTERNAL_TOKEN ? "(set)" : "(not set)",
    REBUILD_ALLOWED_SHOPS: process.env.REBUILD_ALLOWED_SHOPS || "(not set)",
    REBUILD_LOCK_TTL_SEC: process.env.REBUILD_LOCK_TTL_SEC || "600 (default)",
    // Phase X: 부팅 시 자동 Rebuild 환경변수
    REBUILD_AUTO_ON_STARTUP:
      process.env.REBUILD_AUTO_ON_STARTUP || "false (default)",
    REBUILD_AUTO_MODE: process.env.REBUILD_AUTO_MODE || "upsert (default)",
    REBUILD_AUTO_DAYS: process.env.REBUILD_AUTO_DAYS || "30 (default)",
    REBUILD_AUTO_TO_OFFSET_DAYS:
      process.env.REBUILD_AUTO_TO_OFFSET_DAYS || "1 (default)",
    REBUILD_AUTO_IF_EMPTY:
      process.env.REBUILD_AUTO_IF_EMPTY || "true (default)",
    REBUILD_AUTO_SHOPS: process.env.REBUILD_AUTO_SHOPS || "(not set)",
    HOLD_RELEASE_VOID_ALLOW_TOPICS:
      process.env.HOLD_RELEASE_VOID_ALLOW_TOPICS || "(not set)",
    HOLD_RELEASE_CANCEL_FORCE:
      process.env.HOLD_RELEASE_CANCEL_FORCE || "false (default)",
    INTERNAL_RECONCILE_LOCK_TTL_SEC:
      process.env.INTERNAL_RECONCILE_LOCK_TTL_SEC || "600 (default)",
    // Metafield 캐시 환경변수
    PRODUCT_METAFIELD_CACHE_TTL_SEC:
      process.env.PRODUCT_METAFIELD_CACHE_TTL_SEC || "300 (default)",
    SHOP_METAFIELD_CACHE_TTL_SEC:
      process.env.SHOP_METAFIELD_CACHE_TTL_SEC || "300 (default)",
    METAFIELD_FALLBACK_ENABLED:
      process.env.METAFIELD_FALLBACK_ENABLED || "false (default)",
    // Coupons/Discounts 환경변수
    ADMIN_API_KEY: process.env.ADMIN_API_KEY ? "(set)" : "(not set)",
    INTERNAL_EVENT_TOKEN: process.env.INTERNAL_EVENT_TOKEN
      ? "(set)"
      : "(not set)",
    SQUEEZE_EVENT_TOKEN: process.env.SQUEEZE_EVENT_TOKEN
      ? "(set)"
      : "(not set)",
    SHOPIFY_STOREFRONT_TOKEN: process.env.SHOPIFY_STOREFRONT_TOKEN
      ? "(set)"
      : "(not set)",
    SHOPIFY_STOREFRONT_API_VERSION:
      process.env.SHOPIFY_STOREFRONT_API_VERSION || "2025-01 (default)",
    COUPON_CART_ADAPTER: process.env.COUPON_CART_ADAPTER || "(auto)",
    COUPON_SHARE_INTENT_TTL_SEC:
      process.env.COUPON_SHARE_INTENT_TTL_SEC || "3600 (default)",
    COUPON_ALLOW_ENTITLED_OVERRIDE:
      process.env.COUPON_ALLOW_ENTITLED_OVERRIDE || "false (default)",
    COUPON_ALLOW_EXTRA10_WITHOUT_CODE:
      process.env.COUPON_ALLOW_EXTRA10_WITHOUT_CODE || "false (default)",
    COUPON_TOUR_COLLECTION_HANDLES:
      process.env.COUPON_TOUR_COLLECTION_HANDLES ||
      "experience-tours (default)",
    COUPON_TOUR_TAGS: process.env.COUPON_TOUR_TAGS || "TOUR (default)",
    COUPON_TOUR_PRODUCT_TYPES:
      process.env.COUPON_TOUR_PRODUCT_TYPES || "TOUR (default)",
    COUPON_EXTENSION_TAGS:
      process.env.COUPON_EXTENSION_TAGS || "EXTENSION (default)",
    COUPON_EXTENSION_PRODUCT_TYPES:
      process.env.COUPON_EXTENSION_PRODUCT_TYPES || "EXTENSION (default)",
    COUPON_EXTENSION_COLLECTION_HANDLES:
      process.env.COUPON_EXTENSION_COLLECTION_HANDLES || "extensions (default)",
  };

  for (const [key, value] of Object.entries(envVars)) {
    console.log(`${key.padEnd(25)}: ${value || "(not set)"}`);
  }

  console.log("=".repeat(60));
}

/**
 * 환경변수를 로드하고 검증합니다.
 * @throws {z.ZodError} 환경변수 검증 실패 시
 */
export function loadEnv(): Env {
  if (validatedEnv) {
    return validatedEnv;
  }

  const rawEnv = {
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    SHOPIFY_API_SECRET:
      process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_APP_SECRET,
    LOG_LEVEL: process.env.LOG_LEVEL,
    REDIS_URL: process.env.REDIS_URL,
    DATABASE_URL: process.env.DATABASE_URL,
    RATE_LIMIT_PER_MIN: process.env.RATE_LIMIT_PER_MIN,
    STOREFRONT_RATE_LIMIT_V2_MODE: process.env.STOREFRONT_RATE_LIMIT_V2_MODE,
    STOREFRONT_RATE_LIMIT_WINDOW_SEC:
      process.env.STOREFRONT_RATE_LIMIT_WINDOW_SEC,
    STOREFRONT_RATE_LIMIT_MYPAGE_READ_PER_MIN:
      process.env.STOREFRONT_RATE_LIMIT_MYPAGE_READ_PER_MIN,
    STOREFRONT_RATE_LIMIT_SIGNED_URL_PER_MIN:
      process.env.STOREFRONT_RATE_LIMIT_SIGNED_URL_PER_MIN,
    STOREFRONT_RATE_LIMIT_MYPAGE_WRITE_PER_MIN:
      process.env.STOREFRONT_RATE_LIMIT_MYPAGE_WRITE_PER_MIN,
    STOREFRONT_RATE_LIMIT_REDIS_TIMEOUT_MS:
      process.env.STOREFRONT_RATE_LIMIT_REDIS_TIMEOUT_MS,
    STOREFRONT_RATE_LIMIT_REDIS_CIRCUIT_COOLDOWN_MS:
      process.env.STOREFRONT_RATE_LIMIT_REDIS_CIRCUIT_COOLDOWN_MS,
    BOOKING_STORE_TYPE: process.env.BOOKING_STORE_TYPE,
    STORE_TIMEOUT_MS: process.env.STORE_TIMEOUT_MS,
    HOLD_TTL_SEC: process.env.HOLD_TTL_SEC,
    BASE_PRICE_DEFAULT: process.env.BASE_PRICE_DEFAULT,
    TIER_ENABLED: process.env.TIER_ENABLED,
    SERVICE_FEE_DEFAULT: process.env.SERVICE_FEE_DEFAULT,
    PRICING_RULES_JSON: process.env.PRICING_RULES_JSON,
    BLACKOUT_DATES_JSON: process.env.BLACKOUT_DATES_JSON,
    GUIDE_POOL_CAPACITY_DEFAULT: process.env.GUIDE_POOL_CAPACITY_DEFAULT,
    // Phase 5-6R: 내부 Rebuild 환경변수
    INTERNAL_TOKEN: process.env.INTERNAL_TOKEN,
    REBUILD_ALLOWED_SHOPS: process.env.REBUILD_ALLOWED_SHOPS,
    REBUILD_LOCK_TTL_SEC: process.env.REBUILD_LOCK_TTL_SEC,
    // Phase X: 부팅 시 자동 Rebuild 환경변수
    REBUILD_AUTO_ON_STARTUP: process.env.REBUILD_AUTO_ON_STARTUP,
    REBUILD_AUTO_MODE: process.env.REBUILD_AUTO_MODE,
    REBUILD_AUTO_DAYS: process.env.REBUILD_AUTO_DAYS,
    REBUILD_AUTO_TO_OFFSET_DAYS: process.env.REBUILD_AUTO_TO_OFFSET_DAYS,
    REBUILD_AUTO_IF_EMPTY: process.env.REBUILD_AUTO_IF_EMPTY,
    REBUILD_AUTO_SHOPS: process.env.REBUILD_AUTO_SHOPS,
    HOLD_RELEASE_VOID_ALLOW_TOPICS: process.env.HOLD_RELEASE_VOID_ALLOW_TOPICS,
    HOLD_RELEASE_CANCEL_FORCE: process.env.HOLD_RELEASE_CANCEL_FORCE,
    INTERNAL_RECONCILE_LOCK_TTL_SEC:
      process.env.INTERNAL_RECONCILE_LOCK_TTL_SEC,
    // Metafield 캐시 환경변수
    PRODUCT_METAFIELD_CACHE_TTL_SEC:
      process.env.PRODUCT_METAFIELD_CACHE_TTL_SEC,
    SHOP_METAFIELD_CACHE_TTL_SEC: process.env.SHOP_METAFIELD_CACHE_TTL_SEC,
    METAFIELD_FALLBACK_ENABLED: process.env.METAFIELD_FALLBACK_ENABLED,
    // Coupons/Discounts 환경변수
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
    INTERNAL_EVENT_TOKEN: process.env.INTERNAL_EVENT_TOKEN,
    SQUEEZE_EVENT_TOKEN: process.env.SQUEEZE_EVENT_TOKEN,
    SHOPIFY_STOREFRONT_TOKEN: process.env.SHOPIFY_STOREFRONT_TOKEN,
    SHOPIFY_STOREFRONT_API_VERSION: process.env.SHOPIFY_STOREFRONT_API_VERSION,
    COUPON_CART_ADAPTER: process.env.COUPON_CART_ADAPTER,
    COUPON_SHARE_INTENT_TTL_SEC: process.env.COUPON_SHARE_INTENT_TTL_SEC,
    COUPON_ALLOW_ENTITLED_OVERRIDE: process.env.COUPON_ALLOW_ENTITLED_OVERRIDE,
    COUPON_ALLOW_EXTRA10_WITHOUT_CODE:
      process.env.COUPON_ALLOW_EXTRA10_WITHOUT_CODE,
    COUPON_TOUR_COLLECTION_HANDLES: process.env.COUPON_TOUR_COLLECTION_HANDLES,
    COUPON_TOUR_TAGS: process.env.COUPON_TOUR_TAGS,
    COUPON_TOUR_PRODUCT_TYPES: process.env.COUPON_TOUR_PRODUCT_TYPES,
    COUPON_EXTENSION_TAGS: process.env.COUPON_EXTENSION_TAGS,
    COUPON_EXTENSION_PRODUCT_TYPES: process.env.COUPON_EXTENSION_PRODUCT_TYPES,
    COUPON_EXTENSION_COLLECTION_HANDLES:
      process.env.COUPON_EXTENSION_COLLECTION_HANDLES,
  };

  validatedEnv = envSchema.parse(rawEnv);

  // 환경변수 로드 후 로그 출력
  logEnvVars();

  return validatedEnv;
}

/**
 * 환경변수를 가져옵니다 (검증된 값).
 */
export function getEnv(): Env {
  return loadEnv();
}
