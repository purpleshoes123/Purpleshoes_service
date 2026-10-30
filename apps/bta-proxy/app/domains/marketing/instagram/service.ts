import {
  fetchInstagramAccountProfile,
  refreshInstagramLongLivedToken,
  type InstagramClientError,
} from "~/domains/marketing/instagram/client";
import { decryptInstagramToken, encryptInstagramToken } from "~/domains/marketing/instagram/crypto";
import { getInstagramConfig } from "~/domains/marketing/instagram/env";
import {
  getInstagramConnection,
  setInstagramConnection,
} from "~/domains/marketing/instagram/store";
import type {
  InstagramConnection,
  InstagramMediaResponseData,
  InstagramRawMediaItem,
} from "~/domains/marketing/instagram/types";

function nowIso(): string {
  return new Date().toISOString();
}

export function computeTokenExpiresAtIso(expiresInSeconds: number | null): string | null {
  if (!expiresInSeconds || expiresInSeconds <= 0) {
    return null;
  }

  const expiresAtMs = Date.now() + expiresInSeconds * 1000;
  return new Date(expiresAtMs).toISOString();
}

export function shouldRefreshInstagramToken(expiresAtIso: string | null): boolean {
  if (!expiresAtIso) {
    return false;
  }

  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  const thresholdDays = getInstagramConfig().refreshThresholdDays;
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  return expiresAtMs - Date.now() <= thresholdMs;
}

export function buildEmptyInstagramMediaResponse(): InstagramMediaResponseData {
  return {
    items: [],
    pageInfo: {
      hasNextPage: false,
      endCursor: null,
    },
  };
}

export function normalizeInstagramMediaResponse(params: {
  items: InstagramRawMediaItem[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  includeReels: boolean;
}): InstagramMediaResponseData {
  const filtered = params.includeReels
    ? params.items
    : params.items.filter((item) => item.mediaProductType !== "REELS");

  return {
    items: filtered.map((item) => ({
      id: item.id,
      mediaType: item.mediaType || "UNKNOWN",
      mediaUrl: item.mediaUrl || item.thumbnailUrl || "",
      thumbnailUrl: item.thumbnailUrl,
      caption: item.caption || "",
      permalink: item.permalink || "",
      timestamp: item.timestamp || "",
    })),
    pageInfo: params.pageInfo,
  };
}

export async function saveInstagramConnection(params: {
  shop: string;
  accessToken: string;
  expiresIn: number | null;
  profile: {
    instagramUserId: string;
    instagramUsername: string;
    accountType: string | null;
  };
  scopes: string[];
}): Promise<InstagramConnection> {
  const now = nowIso();
  const existing = await getInstagramConnection(params.shop);

  const connection: InstagramConnection = {
    shop: params.shop,
    instagramUserId: params.profile.instagramUserId,
    instagramUsername: params.profile.instagramUsername,
    accountType: params.profile.accountType,
    accessTokenEncrypted: encryptInstagramToken(params.accessToken),
    tokenExpiresAt: computeTokenExpiresAtIso(params.expiresIn),
    scopes: params.scopes,
    connectedAt: existing?.connectedAt || now,
    updatedAt: now,
    status: "connected",
    lastErrorCode: null,
    lastErrorAt: null,
  };

  await setInstagramConnection(connection);
  return connection;
}

export async function markInstagramConnectionError(shop: string, code: string): Promise<void> {
  const existing = await getInstagramConnection(shop);
  if (!existing) {
    return;
  }

  await setInstagramConnection({
    ...existing,
    updatedAt: nowIso(),
    status: "error",
    lastErrorCode: code,
    lastErrorAt: nowIso(),
  });
}

export async function refreshInstagramConnectionTokenIfNeeded(
  shop: string,
  force: boolean = false,
): Promise<InstagramConnection | null> {
  const existing = await getInstagramConnection(shop);
  if (!existing || (existing.status !== "connected" && existing.status !== "error")) {
    return existing;
  }

  if (!force && !shouldRefreshInstagramToken(existing.tokenExpiresAt)) {
    return existing;
  }

  const accessToken = decryptInstagramToken(existing.accessTokenEncrypted);
  const refreshed = await refreshInstagramLongLivedToken(accessToken);
  const profile = await fetchInstagramAccountProfile(refreshed.accessToken);

  const next: InstagramConnection = {
    ...existing,
    instagramUserId: profile.instagramUserId,
    instagramUsername: profile.instagramUsername,
    accountType: profile.accountType,
    accessTokenEncrypted: encryptInstagramToken(refreshed.accessToken),
    tokenExpiresAt: computeTokenExpiresAtIso(refreshed.expiresIn),
    updatedAt: nowIso(),
    status: "connected",
    lastErrorCode: null,
    lastErrorAt: null,
  };

  await setInstagramConnection(next);
  return next;
}

export async function markInstagramConnectionRecovered(shop: string): Promise<void> {
  const existing = await getInstagramConnection(shop);
  if (!existing) {
    return;
  }

  if (existing.status === "connected" && !existing.lastErrorCode && !existing.lastErrorAt) {
    return;
  }

  await setInstagramConnection({
    ...existing,
    status: "connected",
    updatedAt: nowIso(),
    lastErrorCode: null,
    lastErrorAt: null,
  });
}

export function isInstagramClientError(error: unknown): error is InstagramClientError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as any).name === "InstagramClientError"
  );
}
