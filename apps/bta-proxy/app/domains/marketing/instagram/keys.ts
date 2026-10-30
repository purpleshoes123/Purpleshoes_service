const PREFIX = "instagram";

export function instagramConnectionKey(shop: string): string {
  return `${PREFIX}:conn:${shop}`;
}

export function instagramOAuthStateKey(state: string): string {
  return `${PREFIX}:oauth:state:${state}`;
}

export function instagramMediaCacheKey(params: {
  shop: string;
  limit: number;
  after?: string;
  includeReels: boolean;
}): string {
  return `${PREFIX}:media:${params.shop}:${params.limit}:${params.after || ""}:${
    params.includeReels ? "1" : "0"
  }`;
}

export function instagramDebugLastSyncKey(shop: string): string {
  return `${PREFIX}:debug:last-sync:${shop}`;
}
