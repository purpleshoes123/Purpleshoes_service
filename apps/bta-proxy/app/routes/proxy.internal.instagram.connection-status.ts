import type { LoaderFunctionArgs } from "react-router";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getInstagramConnection, getInstagramSyncDebug } from "~/domains/marketing/instagram/store";
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
 * GET /proxy/internal/instagram/connection-status
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  const authResponse = await verifyInternal(request);
  if (authResponse) {
    return authResponse;
  }

  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop") || "");
  if (!shop) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  const connection = await getInstagramConnection(shop);
  const debug = await getInstagramSyncDebug(shop);

  if (!connection) {
    return respond.ok(
      {
        connected: false,
        shop,
        username: null,
        accountType: null,
        tokenExpiresAt: null,
        status: "disconnected",
        updatedAt: null,
        debug,
      },
      { correlationId },
    );
  }

  return respond.ok(
    {
      connected: connection.status === "connected",
      shop,
      username: connection.instagramUsername,
      accountType: connection.accountType,
      tokenExpiresAt: connection.tokenExpiresAt,
      status: connection.status,
      updatedAt: connection.updatedAt,
      lastErrorCode: connection.lastErrorCode,
      lastErrorAt: connection.lastErrorAt,
      debug,
    },
    { correlationId },
  );
};
