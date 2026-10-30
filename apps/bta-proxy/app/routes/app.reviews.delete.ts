import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "~/shopify.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { deleteReviewContent, ReviewServiceError } from "~/domains/reviews/reviewService";
import { logEvent } from "~/lib/logEvent";

const deleteSchema = z.object({
  reviewId: z.string().min(1, "reviewId는 필수입니다."),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const startTime = Date.now();

  if (request.method.toUpperCase() !== "POST") {
    return respond.fail(
      ErrorCode.REVIEW_INVALID_INPUT,
      getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, "지원하지 않는 메서드입니다."),
      undefined,
      getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
      correlationId,
    );
  }

  try {
    const auth = await authenticate.admin(request);
    const shop = auth.session.shop;
    const formData = await request.formData();
    const validated = deleteSchema.parse({
      reviewId: String(formData.get("reviewId") || "").trim(),
    });

    logEvent(
      "review.admin.delete.attempt",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        reviewId: validated.reviewId,
      },
      { correlationId, shop },
    );

    const deleted = await deleteReviewContent({
      shop,
      reviewId: validated.reviewId,
    });

    logEvent(
      "review.admin.delete.success",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        reviewId: deleted.deletedId,
        durationMs: Date.now() - startTime,
      },
      { correlationId, shop },
    );

    return respond.ok(deleted, { correlationId });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    const isValidationError = error && typeof error === "object" && "issues" in error;
    const message = isValidationError
      ? (error as { issues: Array<{ message: string }> }).issues
          .map((issue) => issue.message)
          .join(", ")
      : error instanceof Error
        ? error.message
        : String(error);
    const code =
      error instanceof ReviewServiceError
        ? error.code
        : isValidationError
          ? ErrorCode.REVIEW_INVALID_INPUT
          : ErrorCode.INTERNAL_ERROR;

    logEvent(
      "review.admin.delete.fail",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        errorCode: code,
        reason: message,
        durationMs: Date.now() - startTime,
      },
      { correlationId, severity: code === ErrorCode.INTERNAL_ERROR ? "error" : "warn" },
    );

    return respond.fail(
      code,
      getErrorMessage(code, message),
      error instanceof ReviewServiceError ? error.details : undefined,
      getErrorStatus(code),
      correlationId,
    );
  }
};
