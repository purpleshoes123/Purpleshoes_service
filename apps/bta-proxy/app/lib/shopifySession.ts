import shopify from "~/shopify.server";

export interface SessionLoadContext {
  source?: string;
  correlationId?: string;
}

export function normalizeShopDomain(shop: string): string {
  let normalized = shop.trim();
  if (/^https?:\/\//i.test(normalized)) {
    try {
      normalized = new URL(normalized).hostname;
    } catch {
      // ignore invalid URL, fall back to raw string
    }
  }
  return normalized.toLowerCase();
}

function getSessionExpiresAtMs(session: any): number | null {
  if (!session?.expires) {
    return null;
  }
  if (session.expires instanceof Date) {
    return session.expires.getTime();
  }
  if (typeof session.expires === "number") {
    return session.expires;
  }
  const parsed = Date.parse(String(session.expires));
  return Number.isNaN(parsed) ? null : parsed;
}

function getRefreshTokenExpiresAtMs(session: any): number | null {
  if (!session?.refreshTokenExpires) {
    return null;
  }
  if (session.refreshTokenExpires instanceof Date) {
    return session.refreshTokenExpires.getTime();
  }
  if (typeof session.refreshTokenExpires === "number") {
    return session.refreshTokenExpires;
  }
  const parsed = Date.parse(String(session.refreshTokenExpires));
  return Number.isNaN(parsed) ? null : parsed;
}

function isSessionUsable(session: any): boolean {
  if (!session?.accessToken) {
    return false;
  }
  const expiresAt = getSessionExpiresAtMs(session);
  return expiresAt === null || expiresAt > Date.now();
}

function getSessionUnusableReason(session: any | null): string {
  if (!session) {
    return "not_found";
  }
  if (!session.accessToken) {
    return "missing_access_token";
  }
  const expiresAt = getSessionExpiresAtMs(session);
  if (expiresAt !== null && expiresAt <= Date.now()) {
    return "expired";
  }
  return "not_usable";
}

async function refreshOfflineSession(
  session: any,
  shop: string,
  context: SessionLoadContext
): Promise<any | null> {
  if (!session?.refreshToken) {
    return null;
  }

  const refreshExpiresAt = getRefreshTokenExpiresAtMs(session);
  if (refreshExpiresAt !== null && refreshExpiresAt <= Date.now()) {
    return null;
  }

  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_APP_SECRET;
  if (!apiKey || !apiSecret) {
    return null;
  }

  const normalizedShop = normalizeShopDomain(shop);
  const tokenUrl = `https://${normalizedShop}/admin/oauth/access_token`;

  try {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: apiKey,
        client_secret: apiSecret,
        refresh_token: session.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      if (process.env.DEBUG_BOOKING === "1") {
        console.warn(
          JSON.stringify({
            message: "Offline session refresh failed",
            shop: normalizedShop,
            source: context.source,
            correlationId: context.correlationId,
            status: response.status,
          })
        );
      }
      return null;
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
    };

    if (!payload.access_token) {
      return null;
    }

    session.accessToken = payload.access_token;
    if (typeof payload.expires_in === "number") {
      session.expires = new Date(Date.now() + payload.expires_in * 1000);
    }
    if (payload.refresh_token) {
      session.refreshToken = payload.refresh_token;
    }
    if (typeof payload.refresh_token_expires_in === "number") {
      session.refreshTokenExpires = new Date(
        Date.now() + payload.refresh_token_expires_in * 1000
      );
    }

    await shopify.sessionStorage.storeSession(session);

    if (process.env.DEBUG_BOOKING === "1") {
      console.warn(
        JSON.stringify({
          message: "Offline session refreshed",
          shop: normalizedShop,
          source: context.source,
          correlationId: context.correlationId,
        })
      );
    }

    return session;
  } catch {
    return null;
  }
}

export async function loadOfflineSession(
  shop: string,
  context: SessionLoadContext = {}
): Promise<any | null> {
  const normalizedShop = normalizeShopDomain(shop);
  const offlineSessionId = `offline_${normalizedShop}`;
  let session =
    (await shopify.sessionStorage.loadSession(offlineSessionId)) || null;

  if (isSessionUsable(session)) {
    return session;
  }

  if (session) {
    const refreshed = await refreshOfflineSession(
      session,
      normalizedShop,
      context
    );
    if (refreshed && isSessionUsable(refreshed)) {
      return refreshed;
    }
  }

  const finder = (shopify.sessionStorage as typeof shopify.sessionStorage & {
    findSessionsByShop?: (shopDomain: string) => Promise<any[]>;
  }).findSessionsByShop?.bind(shopify.sessionStorage);

  if (finder) {
    const sessions = await finder(normalizedShop);
    const offline = sessions.find(
      (s) => s && s.isOnline === false && isSessionUsable(s)
    );
    if (offline) {
      if (process.env.DEBUG_BOOKING === "1") {
        console.warn(
          JSON.stringify({
            message: "Offline session loaded via fallback",
            shop: normalizedShop,
            source: context.source,
            correlationId: context.correlationId,
            isOnline: offline.isOnline === true,
          })
        );
      }
      return offline;
    }
    const anySession = sessions.find((s) => s && isSessionUsable(s));
    if (anySession) {
      if (process.env.DEBUG_BOOKING === "1") {
        console.warn(
          JSON.stringify({
            message: "Session loaded via fallback",
            shop: normalizedShop,
            source: context.source,
            correlationId: context.correlationId,
            isOnline: anySession.isOnline === true,
          })
        );
      }
      return anySession;
    }

    const offlineExpired = sessions.find((s) => s && s.isOnline === false);
    if (offlineExpired) {
      const refreshed = await refreshOfflineSession(
        offlineExpired,
        normalizedShop,
        context
      );
      if (refreshed && isSessionUsable(refreshed)) {
        return refreshed;
      }
    }
  }

  if (process.env.DEBUG_BOOKING === "1") {
    console.warn(
      JSON.stringify({
        message: "Offline session not found",
        shop: normalizedShop,
        source: context.source,
        correlationId: context.correlationId,
        reason: getSessionUnusableReason(session),
      })
    );
  }

  return null;
}
