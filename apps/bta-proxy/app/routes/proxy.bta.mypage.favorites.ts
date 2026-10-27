import type { LoaderFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  FavoriteRequestError,
  listFavorites,
  parseFavoriteTypeQuery,
  parseIncludeDeletedQuery,
} from "~/lib/gkv/favorites.server";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/lib/storefront/customerProxy.server";

/**
 * GET /proxy/bta/mypage/favorites
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "customer",
    rateLimitBucket: "mypage-read",
  });
  if (context instanceof Response) return respond.withNoStore(context);

  try {
    const url = new URL(request.url);
    const type = parseFavoriteTypeQuery(url.searchParams.get("type"));
    const includeDeleted = parseIncludeDeletedQuery(
      url.searchParams.get("includeDeleted"),
    );
    const data = await listFavorites({
      customerId: context.customerId,
      type,
      includeDeleted,
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
        message: "Failed to list storefront GKV favorites",
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
