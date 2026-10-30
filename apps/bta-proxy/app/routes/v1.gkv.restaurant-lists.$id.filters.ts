import type { LoaderFunctionArgs } from "react-router";
import { requireGkvCustomerId } from "~/domains/guide-viewer/customerAuth";
import { getStorefrontRestaurantFilterOptionsByListId } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { requireV1BundleRestaurantListAccess } from "~/domains/guide-viewer/v1RestaurantAccess.server.ts";
import { respond } from "~/lib/respond";

/**
 * GET /v1/gkv/restaurant-lists/:id/filters
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const listId = params.id;
  if (!listId) {
    return respond.ok({ areas: [], categories: [], meatTypes: [] }, { correlationId });
  }

  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) {
    return auth;
  }
  const access = await requireV1BundleRestaurantListAccess({
    request,
    customerId: auth.customerId,
    listId,
    correlationId,
  });
  if (access instanceof Response) {
    return access;
  }

  const data = await getStorefrontRestaurantFilterOptionsByListId(listId);
  return respond.ok(data, { correlationId });
};
