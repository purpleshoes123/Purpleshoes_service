import type { LoaderFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { verifyAdminApiKey } from "~/middleware/verifyAdminApiKey";
import { getState, listRevoked } from "~/domains/coupons";
import { normalizeCustomerId } from "~/domains/coupons/normalize";

/**
 * GET /coupons/state?customerId=
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  if (process.env.ADMIN_API_KEY) {
    const authResponse = verifyAdminApiKey(request);
    if (authResponse) {
      return authResponse;
    }
  }

  const url = new URL(request.url);
  const rawCustomerId = url.searchParams.get("customerId");
  const customerId = normalizeCustomerId(rawCustomerId || undefined);
  if (!customerId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  const state = await getState(customerId);
  const revoked = await listRevoked(customerId);

  return respond.ok(
    {
      customerId,
      state,
      revoked: Array.from(revoked).sort(),
    },
    { correlationId },
  );
};
