import type { LoaderFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { listStorefrontRestaurantFilterOptions } from "~/lib/gkv/storefrontViewer.server";
import { respond } from "~/lib/respond";
import { requireStorefrontCustomerProxyContext } from "~/lib/storefront/customerProxy.server";

/**
 * GET /proxy/bta/mypage/restaurant-lists/:id/filters
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const context = await requireStorefrontCustomerProxyContext(request, {
    rateLimitPolicy: "legacy",
  });
  if (context instanceof Response) return context;

  const listId = params.id;
  if (!listId) {
    return respond.ok(
      { areas: [], categories: [], meatTypes: [] },
      { correlationId: context.correlationId },
    );
  }

  const result = await listStorefrontRestaurantFilterOptions(
    request,
    context.customerId,
    listId,
  );
  if (!result.ok) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      context.correlationId,
    );
  }

  return respond.ok(result.data, { correlationId: context.correlationId });
};
