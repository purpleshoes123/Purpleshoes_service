import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import {
  fetchInstagramMedia,
  InstagramClientError,
} from "~/lib/instagram/client";
import {
  clearInstagramMediaCacheForShop,
  getInstagramConnection,
  getInstagramMediaCache,
  setInstagramMediaCache,
  setInstagramSyncDebug,
} from "~/lib/instagram/store";
import {
  buildEmptyInstagramMediaResponse,
  markInstagramConnectionRecovered,
  markInstagramConnectionError,
  normalizeInstagramMediaResponse,
  refreshInstagramConnectionTokenIfNeeded,
} from "~/lib/instagram/service";
import { decryptInstagramToken } from "~/lib/instagram/crypto";
import { getInstagramConfig } from "~/lib/instagram/env";

const querySchema = z.object({
  limit: z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") return undefined;
      const num = typeof value === "string" ? Number(value) : value;
      return Number.isFinite(num) ? num : value;
    }, z.number().int().min(1).max(20).optional().default(8)),
  after: z.string().trim().optional(),
  includeReels: z
    .preprocess((value) => {
      const raw = String(value || "")
        .trim()
        .toLowerCase();
      return raw === "1" || raw === "true";
    }, z.boolean())
    .optional()
    .default(false),
});

function asInstagramClientError(error: unknown): InstagramClientError | null {
  if (error instanceof InstagramClientError) {
    return error;
  }
  return null;
}

function shouldReturnEmptyOnError(errorCode: ErrorCode): boolean {
  return (
    errorCode === ErrorCode.INSTAGRAM_AUTH_REQUIRED ||
    errorCode === ErrorCode.INSTAGRAM_DISCONNECTED ||
    errorCode === ErrorCode.INSTAGRAM_TOKEN_EXPIRED
  );
}

/**
 * GET /proxy/bta/instagram/media
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  const correlationId = respond.getCorrelationId(request);

  try {
    const url = new URL(request.url);
    const validated = querySchema.parse({
      limit: url.searchParams.get("limit") || undefined,
      after: url.searchParams.get("after") || undefined,
      includeReels: url.searchParams.get("includeReels") || undefined,
    });

    const shop = extractShopFromRequest(request);
    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const cached = await getInstagramMediaCache({
      shop,
      limit: validated.limit,
      after: validated.after,
      includeReels: validated.includeReels,
    });
    if (cached) {
      return respond.ok(cached, { correlationId });
    }

    const connection = await getInstagramConnection(shop);
    if (
      !connection ||
      (connection.status !== "connected" && connection.status !== "error")
    ) {
      return respond.ok(buildEmptyInstagramMediaResponse(), { correlationId });
    }

    const refreshedConnection = await refreshInstagramConnectionTokenIfNeeded(shop);
    const activeConnection = refreshedConnection || connection;

    const accessToken = decryptInstagramToken(activeConnection.accessTokenEncrypted);

    const media = await fetchInstagramMedia({
      instagramUserId: activeConnection.instagramUserId,
      accessToken,
      limit: validated.limit,
      after: validated.after,
    });

    const responseData = normalizeInstagramMediaResponse({
      items: media.items,
      pageInfo: media.pageInfo,
      includeReels: validated.includeReels,
    });

    await markInstagramConnectionRecovered(shop);

    const config = getInstagramConfig();
    await setInstagramMediaCache({
      shop,
      limit: validated.limit,
      after: validated.after,
      includeReels: validated.includeReels,
      data: responseData,
      ttlSec: config.mediaCacheTtlSec,
    });

    await setInstagramSyncDebug({
      shop,
      debug: {
        lastSyncedAt: new Date().toISOString(),
        lastErrorCode: null,
        lastErrorAt: null,
        retryCount: 0,
      },
    });

    return respond.ok(responseData, { correlationId });
  } catch (error) {
    const instagramError = asInstagramClientError(error);

    if (instagramError) {
      const shop = extractShopFromRequest(request);
      if (shop) {
        await markInstagramConnectionError(shop, instagramError.code);
        await setInstagramSyncDebug({
          shop,
          debug: {
            lastSyncedAt: null,
            lastErrorCode: instagramError.code,
            lastErrorAt: new Date().toISOString(),
            retryCount: 1,
          },
        });

        if (shouldReturnEmptyOnError(instagramError.code)) {
          await clearInstagramMediaCacheForShop(shop);
          return respond.ok(buildEmptyInstagramMediaResponse(), { correlationId });
        }
      }

      return respond.fail(
        instagramError.code,
        getErrorMessage(instagramError.code, instagramError.message),
        instagramError.details,
        instagramError.status || getErrorStatus(instagramError.code),
        correlationId
      );
    }

    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((issue) => issue.message).join(", ")
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
