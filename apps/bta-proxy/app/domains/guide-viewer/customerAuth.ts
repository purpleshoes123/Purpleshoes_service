import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import {
  hasReviewBearer,
  reservedReviewCustomerId,
} from "~/domains/reviews/reviewer/auth.server.ts";
import {
  authenticateReviewer,
  reviewErrorResponse,
} from "~/domains/reviews/reviewer/request.server.ts";
import {
  verifyTourCustomer,
  TourCompletionRequestError,
} from "~/domains/bookings/customerTourCompletion.server.ts";

/** Identity comes only from verified OAuth or an opaque reviewer session. */
export async function requireGkvCustomerId(
  request: Request,
): Promise<{ customerId: string } | Response> {
  if (hasReviewBearer(request)) {
    try {
      return { customerId: (await authenticateReviewer(request)).customerId };
    } catch (error) {
      return reviewErrorResponse(error, request);
    }
  }
  const correlationId = respond.getCorrelationId(request);
  try {
    const customerId = await verifyTourCustomer(request.headers.get("Authorization"));
    const reserved = reservedReviewCustomerId();
    if (
      reserved &&
      customerId.split("/").pop()!.replace(/^0+/, "") ===
        reserved.split("/").pop()!.replace(/^0+/, "")
    ) {
      throw new TourCompletionRequestError(401, "AUTH_LOGIN_REQUIRED", "Review session required.");
    }
    return { customerId };
  } catch (error) {
    if (!(error instanceof TourCompletionRequestError) || error.status !== 401) {
      // Never include upstream errors or bearer credentials in the response/log.
      return respond.withNoStore(
        respond.fail(
          "AUTH_UNAVAILABLE",
          "Unable to verify your session. Please try again.",
          undefined,
          503,
          correlationId,
        ),
      );
    }
    return respond.withNoStore(
      respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
        correlationId,
      ),
    );
  }
}
