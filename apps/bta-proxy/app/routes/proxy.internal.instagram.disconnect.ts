import type { ActionFunctionArgs } from "react-router";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  clearInstagramConnection,
  clearInstagramMediaCacheForShop,
  setInstagramSyncDebug,
} from "~/domains/marketing/instagram/store";
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
 * POST /proxy/internal/instagram/disconnect
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  const authResponse = await verifyInternal(request);
  if (authResponse) {
    return authResponse;
  }

  try {
    const body = await request.json();
    const shop = normalizeShop(String(body?.shop || ""));

    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    await clearInstagramConnection(shop);
    await clearInstagramMediaCacheForShop(shop);
    await setInstagramSyncDebug({
      shop,
      debug: {
        lastSyncedAt: null,
        lastErrorCode: ErrorCode.INSTAGRAM_DISCONNECTED,
        lastErrorAt: new Date().toISOString(),
        retryCount: 0,
      },
    });

    return respond.ok(
      {
        disconnected: true,
        shop,
      },
      { correlationId },
    );
  } catch {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }
};
