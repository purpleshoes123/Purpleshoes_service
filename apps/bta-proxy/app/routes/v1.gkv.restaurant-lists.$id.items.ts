import type { LoaderFunctionArgs } from "react-router";
import { getStorefrontRestaurantItemsByListId } from "~/domains/guide-viewer/storefrontViewer.server.ts";
import { requireGkvCustomerId } from "~/domains/guide-viewer/customerAuth";
import { requireV1BundleRestaurantListAccess } from "~/domains/guide-viewer/v1RestaurantAccess.server.ts";
import { respond } from "~/lib/respond";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const listId = params.id;
  if (!listId) {
    return respond.ok({ items: [] }, { correlationId });
  }

  let customerId: string | undefined;
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) {
    return auth;
  }
  customerId = auth.customerId;
  const access = await requireV1BundleRestaurantListAccess({
    request,
    customerId: auth.customerId,
    listId,
    correlationId,
  });
  if (access instanceof Response) {
    return access;
  }

  return respond.ok(
    {
      items: await getStorefrontRestaurantItemsByListId(request, listId, customerId),
    },
    { correlationId },
  );
};
