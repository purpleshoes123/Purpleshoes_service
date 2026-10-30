import type { LoaderFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { requireGkvCustomerId } from "~/domains/guide-viewer/customerAuth";
import {
  FavoriteRequestError,
  listFavorites,
  parseFavoriteTypeQuery,
  parseIncludeDeletedQuery,
} from "~/domains/guide-viewer/favorites.server.ts";
import { respond } from "~/lib/respond";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) {
    return respond.withNoStore(auth);
  }
  const correlationId = respond.getCorrelationId(request);

  try {
    const url = new URL(request.url);
    const type = parseFavoriteTypeQuery(url.searchParams.get("type"));
    const includeDeleted = parseIncludeDeletedQuery(url.searchParams.get("includeDeleted"));
    const data = await listFavorites({
      customerId: auth.customerId,
      type,
      includeDeleted,
    });
    return respond.withNoStore(respond.ok(data, { correlationId }));
  } catch (error) {
    if (error instanceof FavoriteRequestError) {
      return respond.withNoStore(
        respond.fail(
          error.code,
          error.message,
          undefined,
          getErrorStatus(error.code),
          correlationId,
        ),
      );
    }
    console.error(
      JSON.stringify({
        message: "Failed to list GKV favorites",
        customerId: auth.customerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return respond.withNoStore(
      respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(ErrorCode.INTERNAL_ERROR),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId,
      ),
    );
  }
};
