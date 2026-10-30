import type { ActionFunctionArgs } from "react-router";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getInstagramConnection, setInstagramSyncDebug } from "~/domains/marketing/instagram/store";
import {
  markInstagramConnectionError,
  refreshInstagramConnectionTokenIfNeeded,
} from "~/domains/marketing/instagram/service";
import { InstagramClientError } from "~/domains/marketing/instagram/client";
import { normalizeShopDomain } from "~/lib/shopifySession";

function normalizeShop(shopRaw: string): string | null {
  const normalized = normalizeShopDomain(shopRaw);
  if (!normalized) {
    return null;
  }
  if (normalized.includes(".")) {
    return normalized;
  }
  return `${normalized}.myshopify.com`;
}

/**
 * POST /proxy/internal/instagram/refresh-token
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  let shop: string | null = null;

  const authResponse = await verifyInternal(request);
  if (authResponse) {
    return authResponse;
  }

  try {
    const body = await request.json();
    shop = normalizeShop(String(body?.shop || ""));

    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const existing = await getInstagramConnection(shop);
    if (!existing || (existing.status !== "connected" && existing.status !== "error")) {
      return respond.fail(
        ErrorCode.INSTAGRAM_DISCONNECTED,
        getErrorMessage(ErrorCode.INSTAGRAM_DISCONNECTED),
        undefined,
        getErrorStatus(ErrorCode.INSTAGRAM_DISCONNECTED),
        correlationId,
      );
    }

    const refreshed = await refreshInstagramConnectionTokenIfNeeded(shop, true);

    await setInstagramSyncDebug({
      shop,
      debug: {
        lastSyncedAt: new Date().toISOString(),
        lastErrorCode: null,
        lastErrorAt: null,
        retryCount: 0,
      },
    });

    return respond.ok(
      {
        refreshed: true,
        shop,
        tokenExpiresAt: refreshed?.tokenExpiresAt || null,
        username: refreshed?.instagramUsername || existing.instagramUsername,
      },
      { correlationId },
    );
  } catch (error) {
    if (error instanceof InstagramClientError) {
      if (shop) {
        await markInstagramConnectionError(shop, error.code);
        await setInstagramSyncDebug({
          shop,
          debug: {
            lastSyncedAt: null,
            lastErrorCode: error.code,
            lastErrorAt: new Date().toISOString(),
            retryCount: 1,
          },
        });
      }

      return respond.fail(
        error.code,
        getErrorMessage(error.code, error.message),
        error.details,
        error.status || getErrorStatus(error.code),
        correlationId,
      );
    }

    if (error instanceof SyntaxError) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
