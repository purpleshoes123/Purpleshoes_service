import type { ActionFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  FavoriteRequestError,
  parseSyncRequestBody,
  syncFavoriteChanges,
} from "~/lib/gkv/favorites.server";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/lib/storefront/customerProxy.server";

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
}

/**
 * POST /proxy/bta/mypage/favorites/sync
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "customer",
    rateLimitBucket: "mypage-write",
  });
  if (context instanceof Response) return respond.withNoStore(context);

  try {
    const body = await readJsonBody(request);
    const parsed = parseSyncRequestBody(body);
    const data = await syncFavoriteChanges({
      customerId: context.customerId,
      deviceId: parsed.deviceId,
      changes: parsed.changes,
    });
    return respond.withNoStore(
      respond.ok(data, { correlationId: context.correlationId }),
    );
  } catch (error) {
    if (error instanceof FavoriteRequestError) {
      return respond.withNoStore(
        respond.fail(
          error.code,
          error.message,
          undefined,
          getErrorStatus(error.code),
          context.correlationId,
        ),
      );
    }
    console.error(
      JSON.stringify({
        message: "Failed to sync storefront GKV favorites",
        shop: context.shop,
        customerId: context.customerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return respond.withNoStore(
      respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(ErrorCode.INTERNAL_ERROR),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        context.correlationId,
      ),
    );
  }
};
