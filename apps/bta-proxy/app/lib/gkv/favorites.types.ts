import type { ErrorCode } from "~/lib/errors";

export const GKV_FAVORITE_TYPES = ["GUIDEBOOK_NODE", "PURPLEMAP_PLACE"] as const;
export const GKV_FAVORITE_ACTIONS = ["ADD", "REMOVE"] as const;
export const GKV_FAVORITE_STATES = ["ACTIVE", "DELETED"] as const;

export type GkvFavoriteType = (typeof GKV_FAVORITE_TYPES)[number];
export type GkvFavoriteAction = (typeof GKV_FAVORITE_ACTIONS)[number];
export type GkvFavoriteState = (typeof GKV_FAVORITE_STATES)[number];

export type FavoriteSyncChangeInput = {
  clientChangeId: string;
  type: GkvFavoriteType;
  targetId: string;
  action: GkvFavoriteAction;
  changedAt: string;
  display?: Record<string, unknown>;
  contentRef?: Record<string, unknown>;
};

export type SerializedFavorite = {
  type: GkvFavoriteType;
  targetId: string;
  state: GkvFavoriteState;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  display: Record<string, unknown>;
  contentRef: Record<string, unknown>;
};

export type FavoriteRejectedChange = {
  clientChangeId: string | null;
  code: ErrorCode | string;
  message: string;
};

export type FavoritesListResult = {
  serverTime: string;
  syncCursor: string;
  items: SerializedFavorite[];
};

export type FavoritesSyncResult = FavoritesListResult & {
  acceptedChangeIds: string[];
  rejectedChanges: FavoriteRejectedChange[];
};
