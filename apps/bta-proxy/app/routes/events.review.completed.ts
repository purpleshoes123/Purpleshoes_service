import type { ActionFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { reviewCompletedSchema } from "~/domains/coupons/validation";
import {
  tryMarkEventOnce,
  getState,
  setReviewCompletedAt,
  grantTourReviewTour15Source,
} from "~/domains/coupons";
import { normalizeCustomerId } from "~/domains/coupons/normalize";
import { verifyInternalEvent } from "~/middleware/verifyInternalEvent";

/**
 * POST /events/review/completed
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifyInternalEvent(request);
  if (authResponse) {
    return authResponse;
  }

  try {
    const body = await request.json();
    const validated = reviewCompletedSchema.parse(body);
    const customerId = normalizeCustomerId(validated.customerId);
    if (!customerId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const marked = await tryMarkEventOnce(
      "review_completed",
      validated.reviewId,
      180 * 24 * 60 * 60,
    );
    if (!marked) {
      return respond.ok({ ok: true, duplicate: true }, { correlationId });
    }

    const completedAt = validated.completedAt || Math.floor(Date.now() / 1000);
    await setReviewCompletedAt(customerId, completedAt);

    const state = await getState(customerId);
    const shouldEntitle = Boolean(state.tourCompletedAt && state.reviewCompletedAt);
    if (shouldEntitle && !state.tour15TourReviewActive) {
      await grantTourReviewTour15Source(customerId);
    }

    console.log(
      JSON.stringify({
        message: "Review completed event processed",
        customerId,
        reviewId: validated.reviewId,
        duplicate: false,
        entitledTour15: shouldEntitle,
      }),
    );

    return respond.ok(
      {
        ok: true,
        duplicate: false,
        entitledTour15: shouldEntitle,
        tourCompletedAt: state.tourCompletedAt,
        reviewCompletedAt: completedAt,
      },
      { correlationId },
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
