import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "~/shopify.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { ReviewServiceError, setReviewVisibility } from "~/domains/reviews/reviewService";
import { logEvent } from "~/lib/logEvent";

const toggleSchema = z.object({
  reviewId: z.string().min(1, "reviewId는 필수입니다."),
  visible: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const startTime = Date.now();

  if (request.method.toUpperCase() !== "POST") {
    logEvent(
      "review.admin.toggle.fail",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        errorCode: ErrorCode.REVIEW_INVALID_INPUT,
        reason: "invalid_method",
        durationMs: Date.now() - startTime,
      },
      { correlationId, severity: "warn" },
    );
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
    const payload = {
      reviewId: String(formData.get("reviewId") || "").trim(),
      visible: String(formData.get("visible") || "").trim(),
    };

    const validated = toggleSchema.parse(payload);

    logEvent(
      "review.admin.toggle.attempt",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        reviewId: validated.reviewId,
        visible: validated.visible,
      },
      { correlationId, shop },
    );

    const updated = await setReviewVisibility({
      shop,
      reviewId: validated.reviewId,
      visible: validated.visible,
    });

    logEvent(
      "review.admin.toggle.success",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        reviewId: validated.reviewId,
        status: updated.status,
        durationMs: Date.now() - startTime,
      },
      { correlationId, shop },
    );

    return respond.ok({ item: updated }, { correlationId });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      logEvent(
        "review.admin.toggle.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          errorCode: ErrorCode.REVIEW_INVALID_INPUT,
          reason: errorMessage,
          durationMs: Date.now() - startTime,
        },
        { correlationId, severity: "warn" },
      );
      return respond.fail(
        ErrorCode.REVIEW_INVALID_INPUT,
        getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
        correlationId,
      );
    }

    if (error instanceof ReviewServiceError) {
      logEvent(
        "review.admin.toggle.fail",
        {
          path: new URL(request.url).pathname,
          method: "POST",
          errorCode: error.code,
          reason: error.message,
          durationMs: Date.now() - startTime,
        },
        { correlationId, severity: "error" },
      );
      return respond.fail(
        error.code,
        getErrorMessage(error.code, error.message),
        error.details,
        getErrorStatus(error.code),
        correlationId,
      );
    }

    logEvent(
      "review.admin.toggle.fail",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        errorCode: ErrorCode.INTERNAL_ERROR,
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      },
      { correlationId, severity: "error" },
    );
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
