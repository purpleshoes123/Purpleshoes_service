export type InstagramConnectionStatus = "connected" | "disconnected" | "error";

export type InstagramConnection = {
  shop: string;
  instagramUserId: string;
  instagramUsername: string;
  accountType: string | null;
  accessTokenEncrypted: string;
  tokenExpiresAt: string | null;
  scopes: string[];
  connectedAt: string;
  updatedAt: string;
  status: InstagramConnectionStatus;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
};

export type InstagramOAuthStatePayload = {
  shop: string;
  returnTo: string | null;
  createdAt: string;
};

export type InstagramRawMediaItem = {
  id: string;
  mediaType: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  permalink: string | null;
  timestamp: string | null;
  mediaProductType: string | null;
};

export type InstagramMediaPageInfo = {
  hasNextPage: boolean;
  endCursor: string | null;
};

export type InstagramMediaResponseItem = {
  id: string;
  mediaType: string;
  mediaUrl: string;
  thumbnailUrl: string | null;
  caption: string;
  permalink: string;
  timestamp: string;
};

export type InstagramMediaResponseData = {
  items: InstagramMediaResponseItem[];
  pageInfo: InstagramMediaPageInfo;
};

export type InstagramSyncDebug = {
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  retryCount: number;
};
