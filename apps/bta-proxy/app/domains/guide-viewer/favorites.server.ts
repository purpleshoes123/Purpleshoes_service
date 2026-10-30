import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import prisma from "~/db.server.ts";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import type {
  FavoriteRejectedChange,
  FavoritesListResult,
  FavoritesSyncResult,
  GkvFavoriteAction,
  GkvFavoriteState,
  GkvFavoriteType,
  SerializedFavorite,
} from "./favorites.types.ts";
import { GKV_FAVORITE_ACTIONS, GKV_FAVORITE_TYPES } from "./favorites.types.ts";

const MAX_SYNC_CHANGES = 100;
const MAX_FAVORITES_PER_TYPE = 1000;
const MAX_TARGET_ID_LENGTH = 300;
const MAX_JSON_BYTES = 2048;
const MAX_DEVICE_ID_LENGTH = 200;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FavoriteRequestError extends Error {
  code: ErrorCode;

  constructor(code: ErrorCode, message = getErrorMessage(code)) {
    super(message);
    this.name = "FavoriteRequestError";
    this.code = code;
  }
}

type SanitizedFavoriteChange = {
  clientChangeId: string;
  type: GkvFavoriteType;
  targetId: string;
  action: GkvFavoriteAction;
  changedAt: Date;
  changedAtIso: string;
  display: Record<string, unknown>;
  contentRef: Record<string, unknown>;
  payloadJson: string;
  payloadHash: string;
};

type FavoriteRow = {
  type: string;
  targetId: string;
  state: string;
  displayJson: string;
  contentRefJson: string;
  lastChangedAt: Date;
  createdAt: Date;
  deletedAt: Date | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFavoriteType(value: unknown): value is GkvFavoriteType {
  return typeof value === "string" && GKV_FAVORITE_TYPES.includes(value as GkvFavoriteType);
}

function isFavoriteAction(value: unknown): value is GkvFavoriteAction {
  return typeof value === "string" && GKV_FAVORITE_ACTIONS.includes(value as GkvFavoriteAction);
}

function optionalString(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function requireString(value: unknown, code: ErrorCode, maxLength = MAX_TARGET_ID_LENGTH): string {
  if (typeof value !== "string") {
    throw new FavoriteRequestError(code);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new FavoriteRequestError(code);
  }
  return trimmed;
}

function assertJsonSize(value: Record<string, unknown>, code: ErrorCode) {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_JSON_BYTES) {
    throw new FavoriteRequestError(code);
  }
}

function parseIsoDate(value: unknown): { date: Date; iso: string } {
  if (typeof value !== "string") {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  return { date, iso: date.toISOString() };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashPayload(payloadJson: string): string {
  return createHash("sha256").update(payloadJson, "utf8").digest("hex");
}

function buildSyncCursor(serverTime: Date): string {
  return Buffer.from(`favorites:${serverTime.toISOString()}`, "utf8").toString("base64url");
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sanitizeGuidebookChange(input: {
  targetId: string;
  display: Record<string, unknown>;
  contentRef: Record<string, unknown>;
}) {
  const nodeId = requireString(input.contentRef.nodeId, ErrorCode.FAVORITE_INVALID_TARGET);
  if (input.targetId !== nodeId) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_TARGET);
  }

  const display = {
    ...(optionalString(input.display.pathLabel)
      ? { pathLabel: optionalString(input.display.pathLabel) }
      : {}),
    ...(optionalString(input.display.title) ? { title: optionalString(input.display.title) } : {}),
  };
  const contentRef = { nodeId };
  assertJsonSize(display, ErrorCode.FAVORITE_INVALID_CHANGE);
  assertJsonSize(contentRef, ErrorCode.FAVORITE_INVALID_CHANGE);
  return { display, contentRef };
}

function sanitizePurpleMapChange(input: {
  targetId: string;
  display: Record<string, unknown>;
  contentRef: Record<string, unknown>;
}) {
  const restaurantListId = requireString(
    input.contentRef.restaurantListId,
    ErrorCode.FAVORITE_INVALID_TARGET,
  );
  const placeId = requireString(input.contentRef.placeId, ErrorCode.FAVORITE_INVALID_TARGET);
  if (input.targetId !== `${restaurantListId}:${placeId}`) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_TARGET);
  }

  const display = {
    ...(optionalString(input.display.name) ? { name: optionalString(input.display.name) } : {}),
  };
  const contentRef = { restaurantListId, placeId };
  assertJsonSize(display, ErrorCode.FAVORITE_INVALID_CHANGE);
  assertJsonSize(contentRef, ErrorCode.FAVORITE_INVALID_CHANGE);
  return { display, contentRef };
}

function sanitizeChange(raw: unknown): SanitizedFavoriteChange {
  if (!isRecord(raw)) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }

  const clientChangeId = requireString(raw.clientChangeId, ErrorCode.FAVORITE_INVALID_CHANGE);
  if (!UUID_RE.test(clientChangeId)) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  if (!isFavoriteType(raw.type)) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_TYPE);
  }
  if (!isFavoriteAction(raw.action)) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  const targetId = requireString(raw.targetId, ErrorCode.FAVORITE_INVALID_TARGET);
  const { date: changedAt, iso: changedAtIso } = parseIsoDate(raw.changedAt);
  const display = isRecord(raw.display) ? raw.display : {};
  const contentRef = isRecord(raw.contentRef) ? raw.contentRef : {};

  const sanitized =
    raw.type === "GUIDEBOOK_NODE"
      ? sanitizeGuidebookChange({ targetId, display, contentRef })
      : sanitizePurpleMapChange({ targetId, display, contentRef });

  const canonicalPayload = {
    action: raw.action,
    changedAt: changedAtIso,
    clientChangeId,
    contentRef: sanitized.contentRef,
    display: sanitized.display,
    targetId,
    type: raw.type,
  };
  const payloadJson = stableStringify(canonicalPayload);

  return {
    clientChangeId,
    type: raw.type,
    targetId,
    action: raw.action,
    changedAt,
    changedAtIso,
    display: sanitized.display,
    contentRef: sanitized.contentRef,
    payloadJson,
    payloadHash: hashPayload(payloadJson),
  };
}

function effectiveChangedAt(changedAt: Date, serverTime: Date): Date {
  return changedAt.getTime() > serverTime.getTime() + CLOCK_SKEW_MS ? serverTime : changedAt;
}

function shouldApplyChange(params: {
  existing: { state: string; lastChangedAt: Date } | null;
  action: GkvFavoriteAction;
  effectiveChangedAt: Date;
}) {
  if (!params.existing) {
    return true;
  }
  const existingTime = params.existing.lastChangedAt.getTime();
  const nextTime = params.effectiveChangedAt.getTime();
  if (nextTime > existingTime) {
    return true;
  }
  if (nextTime < existingTime) {
    return false;
  }
  return params.action === "REMOVE" && params.existing.state !== "DELETED";
}

async function canAddFavorite(params: {
  tx: Prisma.TransactionClient;
  customerId: string;
  type: GkvFavoriteType;
  existing: { state: string } | null;
}) {
  if (params.existing?.state === "ACTIVE") {
    return true;
  }
  const activeCount = await params.tx.gkvFavorite.count({
    where: {
      customerId: params.customerId,
      type: params.type,
      state: "ACTIVE",
    },
  });
  return activeCount < MAX_FAVORITES_PER_TYPE;
}

async function applyFavoriteChange(params: {
  tx: Prisma.TransactionClient;
  customerId: string;
  change: SanitizedFavoriteChange;
  effectiveChangedAt: Date;
}): Promise<FavoriteRejectedChange | null> {
  const existing = await params.tx.gkvFavorite.findUnique({
    where: {
      customerId_type_targetId: {
        customerId: params.customerId,
        type: params.change.type,
        targetId: params.change.targetId,
      },
    },
    select: { id: true, state: true, lastChangedAt: true },
  });

  if (
    params.change.action === "ADD" &&
    !(await canAddFavorite({
      tx: params.tx,
      customerId: params.customerId,
      type: params.change.type,
      existing,
    }))
  ) {
    return {
      clientChangeId: params.change.clientChangeId,
      code: ErrorCode.FAVORITE_INVALID_CHANGE,
      message: "즐겨찾기 최대 개수를 초과했습니다.",
    };
  }

  if (
    !shouldApplyChange({
      existing,
      action: params.change.action,
      effectiveChangedAt: params.effectiveChangedAt,
    })
  ) {
    return null;
  }

  const state: GkvFavoriteState = params.change.action === "ADD" ? "ACTIVE" : "DELETED";
  const deletedAt = params.change.action === "REMOVE" ? params.effectiveChangedAt : null;
  await params.tx.gkvFavorite.upsert({
    where: {
      customerId_type_targetId: {
        customerId: params.customerId,
        type: params.change.type,
        targetId: params.change.targetId,
      },
    },
    create: {
      customerId: params.customerId,
      type: params.change.type,
      targetId: params.change.targetId,
      state,
      displayJson: stableStringify(params.change.display),
      contentRefJson: stableStringify(params.change.contentRef),
      lastChangedAt: params.effectiveChangedAt,
      deletedAt,
    },
    update: {
      state,
      displayJson: stableStringify(params.change.display),
      contentRefJson: stableStringify(params.change.contentRef),
      lastChangedAt: params.effectiveChangedAt,
      deletedAt,
    },
  });

  return null;
}

function serializeFavorite(row: FavoriteRow): SerializedFavorite {
  return {
    type: row.type as GkvFavoriteType,
    targetId: row.targetId,
    state: row.state as GkvFavoriteState,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.lastChangedAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    display: parseJsonRecord(row.displayJson),
    contentRef: parseJsonRecord(row.contentRefJson),
  };
}

export async function listFavorites(params: {
  customerId: string;
  type?: GkvFavoriteType;
  includeDeleted?: boolean;
  serverTime?: Date;
}): Promise<FavoritesListResult> {
  const serverTime = params.serverTime ?? new Date();
  const rows = await prisma.gkvFavorite.findMany({
    where: {
      customerId: params.customerId,
      ...(params.type ? { type: params.type } : {}),
      ...(params.includeDeleted ? {} : { state: "ACTIVE" }),
    },
    orderBy: [{ lastChangedAt: "desc" }, { type: "asc" }, { targetId: "asc" }],
  });

  return {
    serverTime: serverTime.toISOString(),
    syncCursor: buildSyncCursor(serverTime),
    items: rows.map(serializeFavorite),
  };
}

export function parseFavoriteTypeQuery(rawType: string | null): GkvFavoriteType | undefined {
  if (!rawType) {
    return undefined;
  }
  if (!isFavoriteType(rawType)) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_TYPE);
  }
  return rawType;
}

export function parseIncludeDeletedQuery(raw: string | null): boolean {
  if (!raw) {
    return false;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
}

export function parseSyncRequestBody(body: unknown): {
  deviceId: string | null;
  changes: SanitizedFavoriteChange[];
} {
  if (!isRecord(body)) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  const rawDeviceId = body.deviceId;
  const deviceId =
    typeof rawDeviceId === "string" && rawDeviceId.trim()
      ? rawDeviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH)
      : null;
  if (rawDeviceId !== undefined && rawDeviceId !== null && deviceId === null) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  if (
    body.baseCursor !== undefined &&
    body.baseCursor !== null &&
    typeof body.baseCursor !== "string"
  ) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  if (!Array.isArray(body.changes)) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
  if (body.changes.length > MAX_SYNC_CHANGES) {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_BATCH_TOO_LARGE);
  }
  return {
    deviceId,
    changes: body.changes.map(sanitizeChange),
  };
}

export async function syncFavoriteChanges(params: {
  customerId: string;
  deviceId: string | null;
  changes: SanitizedFavoriteChange[];
}): Promise<FavoritesSyncResult> {
  const serverTime = new Date();
  const acceptedChangeIds: string[] = [];
  const rejectedChanges: FavoriteRejectedChange[] = [];

  await prisma.$transaction(async (tx) => {
    for (const change of params.changes) {
      const existingChange = await tx.gkvFavoriteChange.findFirst({
        where: {
          customerId: params.customerId,
          clientChangeId: change.clientChangeId,
        },
      });

      if (existingChange) {
        if (existingChange.payloadHash === change.payloadHash) {
          acceptedChangeIds.push(change.clientChangeId);
        } else {
          rejectedChanges.push({
            clientChangeId: change.clientChangeId,
            code: ErrorCode.FAVORITE_IDEMPOTENCY_CONFLICT,
            message: getErrorMessage(ErrorCode.FAVORITE_IDEMPOTENCY_CONFLICT),
          });
        }
        continue;
      }

      const nextEffectiveChangedAt = effectiveChangedAt(change.changedAt, serverTime);
      const applyRejection = await applyFavoriteChange({
        tx,
        customerId: params.customerId,
        change,
        effectiveChangedAt: nextEffectiveChangedAt,
      });
      if (applyRejection) {
        rejectedChanges.push(applyRejection);
        continue;
      }

      await tx.gkvFavoriteChange.create({
        data: {
          customerId: params.customerId,
          clientChangeId: change.clientChangeId,
          deviceId: params.deviceId,
          type: change.type,
          targetId: change.targetId,
          action: change.action,
          changedAt: change.changedAt,
          effectiveChangedAt: nextEffectiveChangedAt,
          payloadHash: change.payloadHash,
          payloadJson: change.payloadJson,
        },
      });
      acceptedChangeIds.push(change.clientChangeId);
    }
  });

  const list = await listFavorites({
    customerId: params.customerId,
    serverTime,
  });
  return {
    ...list,
    acceptedChangeIds,
    rejectedChanges,
  };
}
