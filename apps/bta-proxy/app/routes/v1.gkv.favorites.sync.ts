import type { ActionFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { requireGkvCustomerId } from "~/lib/gkv/customerAuth";
import {
  FavoriteRequestError,
  parseSyncRequestBody,
  syncFavoriteChanges,
} from "~/lib/gkv/favorites.server";
import { respond } from "~/lib/respond";

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new FavoriteRequestError(ErrorCode.FAVORITE_INVALID_CHANGE);
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) return respond.withNoStore(auth);
  const correlationId = respond.getCorrelationId(request);

  try {
    const body = await readJsonBody(request);
    const parsed = parseSyncRequestBody(body);
    const data = await syncFavoriteChanges({
      customerId: auth.customerId,
      deviceId: parsed.deviceId,
      changes: parsed.changes,
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
        message: "Failed to sync GKV favorites",
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
