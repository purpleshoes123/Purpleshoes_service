import { normalizeShopDomain } from "~/lib/shopifySession";

const DEFAULT_GRAPH_BASE_URL = "https://graph.instagram.com";
const DEFAULT_OAUTH_AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const DEFAULT_OAUTH_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const DEFAULT_OAUTH_SCOPES = "instagram_business_basic";
const DEFAULT_STATE_TTL_SEC = 600;
const DEFAULT_MEDIA_CACHE_TTL_SEC = 180;
const DEFAULT_REFRESH_THRESHOLD_DAYS = 7;

function toPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toNormalizedShop(raw: string): string {
  const normalized = normalizeShopDomain(raw);
  if (!normalized) {
    return "";
  }
  if (normalized.includes(".")) {
    return normalized;
  }
  return `${normalized}.myshopify.com`;
}

function normalizeUrl(raw: string | undefined, fallback: string): string {
  const value = (raw || "").trim();
  if (!value) {
    return fallback;
  }
  return value;
}

export type InstagramConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphBaseUrl: string;
  oauthAuthorizeUrl: string;
  oauthTokenUrl: string;
  oauthScopes: string;
  stateTtlSec: number;
  mediaCacheTtlSec: number;
  refreshThresholdDays: number;
  allowedShops: Set<string>;
};

export function getInstagramConfig(): InstagramConfig {
  const allowedRaw = (process.env.INSTAGRAM_ALLOWED_SHOPS || "")
    .split(",")
    .map((item) => toNormalizedShop(item.trim()))
    .filter(Boolean);

  return {
    appId: (process.env.INSTAGRAM_APP_ID || "").trim(),
    appSecret: (process.env.INSTAGRAM_APP_SECRET || "").trim(),
    redirectUri: (process.env.INSTAGRAM_REDIRECT_URI || "").trim(),
    graphBaseUrl: normalizeUrl(process.env.INSTAGRAM_GRAPH_BASE_URL, DEFAULT_GRAPH_BASE_URL),
    oauthAuthorizeUrl: normalizeUrl(
      process.env.INSTAGRAM_OAUTH_AUTHORIZE_URL,
      DEFAULT_OAUTH_AUTHORIZE_URL,
    ),
    oauthTokenUrl: normalizeUrl(process.env.INSTAGRAM_OAUTH_TOKEN_URL, DEFAULT_OAUTH_TOKEN_URL),
    oauthScopes: (process.env.INSTAGRAM_OAUTH_SCOPES || "").trim() || DEFAULT_OAUTH_SCOPES,
    stateTtlSec: toPositiveInt(process.env.INSTAGRAM_STATE_TTL_SEC, DEFAULT_STATE_TTL_SEC),
    mediaCacheTtlSec: toPositiveInt(
      process.env.INSTAGRAM_MEDIA_CACHE_TTL_SEC,
      DEFAULT_MEDIA_CACHE_TTL_SEC,
    ),
    refreshThresholdDays: toPositiveInt(
      process.env.INSTAGRAM_REFRESH_THRESHOLD_DAYS,
      DEFAULT_REFRESH_THRESHOLD_DAYS,
    ),
    allowedShops: new Set(allowedRaw),
  };
}

export function ensureInstagramOAuthConfig(config: InstagramConfig): void {
  if (!config.appId) {
    throw new Error("INSTAGRAM_APP_ID is required");
  }
  if (!config.appSecret) {
    throw new Error("INSTAGRAM_APP_SECRET is required");
  }
  if (!config.redirectUri) {
    throw new Error("INSTAGRAM_REDIRECT_URI is required");
  }
}

export function isInstagramShopAllowed(shop: string, config: InstagramConfig): boolean {
  if (config.allowedShops.size === 0) {
    return true;
  }
  return config.allowedShops.has(toNormalizedShop(shop));
}
