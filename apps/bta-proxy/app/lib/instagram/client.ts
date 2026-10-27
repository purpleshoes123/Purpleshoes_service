import { ErrorCode } from "~/lib/errors";
import { getInstagramConfig, type InstagramConfig } from "~/lib/instagram/env";
import type { InstagramRawMediaItem } from "~/lib/instagram/types";

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_RETRY_COUNT = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function joinUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function isTokenExpiredError(payload: any): boolean {
  const code = payload?.error?.code;
  const subcode = payload?.error?.error_subcode;
  const type = String(payload?.error?.type || "").toLowerCase();

  return code === 190 || subcode === 463 || type === "oauth_exception";
}

function ensureRequired(value: string, envName: string): void {
  if (!value || !value.trim()) {
    throw new InstagramClientError(
      ErrorCode.INTERNAL_ERROR,
      `${envName} is required`,
      500
    );
  }
}

export class InstagramClientError extends Error {
  code: ErrorCode;
  status: number;
  details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "InstagramClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestInstagramJson(
  url: string,
  init: RequestInit,
  options?: {
    timeoutMs?: number;
    retryCount?: number;
    fallbackErrorCode?: ErrorCode;
  }
): Promise<any> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryCount = options?.retryCount ?? DEFAULT_RETRY_COUNT;
  const fallbackErrorCode = options?.fallbackErrorCode ?? ErrorCode.INSTAGRAM_API_ERROR;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};

      if (payload?.error) {
        if (isTokenExpiredError(payload)) {
          throw new InstagramClientError(
            ErrorCode.INSTAGRAM_TOKEN_EXPIRED,
            payload.error.message || "Instagram token expired",
            401,
            {
              type: payload.error.type,
              code: payload.error.code,
              subcode: payload.error.error_subcode,
            }
          );
        }

        throw new InstagramClientError(
          fallbackErrorCode,
          payload.error.message || "Instagram API error",
          response.status || 502,
          {
            type: payload.error.type,
            code: payload.error.code,
            subcode: payload.error.error_subcode,
          }
        );
      }

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < retryCount) {
          await sleep(250 * (attempt + 1));
          continue;
        }

        throw new InstagramClientError(
          fallbackErrorCode,
          `Instagram API request failed (status=${response.status})`,
          response.status,
          {
            status: response.status,
          }
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof InstagramClientError) {
        if (isRetryableStatus(error.status) && attempt < retryCount) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      const isAbort = message.toLowerCase().includes("abort");
      lastError = error instanceof Error ? error : new Error(message);

      if (attempt < retryCount && isAbort) {
        await sleep(250 * (attempt + 1));
        continue;
      }

      throw new InstagramClientError(
        fallbackErrorCode,
        isAbort ? "Instagram API timeout" : "Instagram API request failed",
        502,
        {
          reason: isAbort ? "timeout" : "network",
        }
      );
    }
  }

  throw new InstagramClientError(
    fallbackErrorCode,
    lastError?.message || "Instagram request failed",
    502
  );
}

function buildGraphUrl(path: string, params: URLSearchParams, config: InstagramConfig): string {
  const url = new URL(joinUrl(config.graphBaseUrl, path));
  params.forEach((value, key) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

export function buildInstagramAuthorizeUrl(state: string): string {
  const config = getInstagramConfig();
  const url = new URL(config.oauthAuthorizeUrl);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.oauthScopes);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForInstagramToken(code: string): Promise<{
  accessToken: string;
  userId: string | null;
}> {
  const config = getInstagramConfig();
  ensureRequired(config.appId, "INSTAGRAM_APP_ID");
  ensureRequired(config.appSecret, "INSTAGRAM_APP_SECRET");
  ensureRequired(config.redirectUri, "INSTAGRAM_REDIRECT_URI");

  const body = new URLSearchParams();
  body.set("client_id", config.appId);
  body.set("client_secret", config.appSecret);
  body.set("grant_type", "authorization_code");
  body.set("redirect_uri", config.redirectUri);
  body.set("code", code);

  const payload = await requestInstagramJson(
    config.oauthTokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    {
      fallbackErrorCode: ErrorCode.INSTAGRAM_TOKEN_EXCHANGE_FAILED,
    }
  );

  const accessToken = String(payload?.access_token || "").trim();
  if (!accessToken) {
    throw new InstagramClientError(
      ErrorCode.INSTAGRAM_TOKEN_EXCHANGE_FAILED,
      "Instagram short-lived access token is missing",
      502
    );
  }

  return {
    accessToken,
    userId: payload?.user_id ? String(payload.user_id) : null,
  };
}

export async function exchangeLongLivedInstagramToken(
  shortLivedAccessToken: string
): Promise<{ accessToken: string; expiresIn: number | null }> {
  const config = getInstagramConfig();
  ensureRequired(config.appSecret, "INSTAGRAM_APP_SECRET");
  const params = new URLSearchParams();
  params.set("grant_type", "ig_exchange_token");
  params.set("client_secret", config.appSecret);
  params.set("access_token", shortLivedAccessToken);

  const payload = await requestInstagramJson(
    buildGraphUrl("/access_token", params, config),
    {
      method: "GET",
    },
    {
      fallbackErrorCode: ErrorCode.INSTAGRAM_TOKEN_EXCHANGE_FAILED,
    }
  );

  const accessToken = String(payload?.access_token || "").trim();
  if (!accessToken) {
    throw new InstagramClientError(
      ErrorCode.INSTAGRAM_TOKEN_EXCHANGE_FAILED,
      "Instagram long-lived access token is missing",
      502
    );
  }

  const expiresIn = Number(payload?.expires_in);

  return {
    accessToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
  };
}

export async function refreshInstagramLongLivedToken(accessToken: string): Promise<{
  accessToken: string;
  expiresIn: number | null;
}> {
  const config = getInstagramConfig();
  const params = new URLSearchParams();
  params.set("grant_type", "ig_refresh_token");
  params.set("access_token", accessToken);

  const payload = await requestInstagramJson(
    buildGraphUrl("/refresh_access_token", params, config),
    {
      method: "GET",
    },
    {
      fallbackErrorCode: ErrorCode.INSTAGRAM_API_ERROR,
    }
  );

  const nextToken = String(payload?.access_token || "").trim() || accessToken;
  const expiresIn = Number(payload?.expires_in);

  return {
    accessToken: nextToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
  };
}

export async function fetchInstagramAccountProfile(accessToken: string): Promise<{
  instagramUserId: string;
  instagramUsername: string;
  accountType: string | null;
}> {
  const config = getInstagramConfig();
  const params = new URLSearchParams();
  params.set("fields", "user_id,username,account_type");
  params.set("access_token", accessToken);

  const payload = await requestInstagramJson(
    buildGraphUrl("/me", params, config),
    {
      method: "GET",
    },
    {
      fallbackErrorCode: ErrorCode.INSTAGRAM_API_ERROR,
    }
  );

  const instagramUserId = String(payload?.user_id || payload?.id || "").trim();
  const instagramUsername = String(payload?.username || "").trim();

  if (!instagramUserId || !instagramUsername) {
    throw new InstagramClientError(
      ErrorCode.INSTAGRAM_API_ERROR,
      "Instagram account profile is incomplete",
      502
    );
  }

  return {
    instagramUserId,
    instagramUsername,
    accountType: payload?.account_type ? String(payload.account_type) : null,
  };
}

export async function fetchInstagramMedia(params: {
  instagramUserId: string;
  accessToken: string;
  limit: number;
  after?: string;
}): Promise<{
  items: InstagramRawMediaItem[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}> {
  const config = getInstagramConfig();
  const query = new URLSearchParams();
  query.set(
    "fields",
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,media_product_type"
  );
  query.set("limit", String(params.limit));
  query.set("access_token", params.accessToken);
  if (params.after) {
    query.set("after", params.after);
  }

  const payload = await requestInstagramJson(
    buildGraphUrl(`/${encodeURIComponent(params.instagramUserId)}/media`, query, config),
    {
      method: "GET",
    },
    {
      fallbackErrorCode: ErrorCode.INSTAGRAM_API_ERROR,
    }
  );

  const data = Array.isArray(payload?.data) ? payload.data : [];
  const items: InstagramRawMediaItem[] = data
    .map((item: any) => {
      const id = String(item?.id || "").trim();
      if (!id) {
        return null;
      }
      return {
        id,
        mediaType: String(item?.media_type || "").trim().toUpperCase(),
        mediaUrl: item?.media_url ? String(item.media_url) : null,
        thumbnailUrl: item?.thumbnail_url ? String(item.thumbnail_url) : null,
        caption: item?.caption ? String(item.caption) : null,
        permalink: item?.permalink ? String(item.permalink) : null,
        timestamp: item?.timestamp ? String(item.timestamp) : null,
        mediaProductType: item?.media_product_type
          ? String(item.media_product_type).toUpperCase()
          : null,
      };
    })
    .filter((item: InstagramRawMediaItem | null): item is InstagramRawMediaItem => Boolean(item));

  const endCursor = payload?.paging?.cursors?.after
    ? String(payload.paging.cursors.after)
    : null;

  return {
    items,
    pageInfo: {
      hasNextPage: Boolean(payload?.paging?.next),
      endCursor,
    },
  };
}
