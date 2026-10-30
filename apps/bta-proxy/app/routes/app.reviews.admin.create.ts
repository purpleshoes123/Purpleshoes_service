import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "~/shopify.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getAdminReviewLabel } from "~/domains/reviews/reviewAdminLabel";
import {
  createAdminReviewMetaobject,
  resolveHomepageReviewAnchorProductId,
  ReviewServiceError,
} from "~/domains/reviews/reviewService";
import { logEvent } from "~/lib/logEvent";

const createAdminReviewSchema = z.object({
  placement: z.enum(["homepage", "product"]),
  productId: z.string().optional(),
  body: z
    .string()
    .trim()
    .min(20, "body는 최소 20자 이상이어야 합니다.")
    .max(2000, "body는 최대 2000자까지 가능합니다."),
  authorDisplayName: z.string().optional(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const startTime = Date.now();

  if (request.method.toUpperCase() !== "POST") {
    logEvent(
      "review.admin.create.fail",
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
      productId: String(formData.get("productId") || "").trim(),
      placement: String(formData.get("placement") || "product").trim(),
      body: String(formData.get("body") || "").trim(),
      authorDisplayName: String(formData.get("authorDisplayName") || "").trim(),
    };

    const validated = createAdminReviewSchema.parse({
      placement: payload.placement,
      productId: payload.productId,
      body: payload.body,
      authorDisplayName: payload.authorDisplayName || undefined,
    });

    if (validated.placement === "product" && !validated.productId?.trim()) {
      return respond.fail(
        ErrorCode.REVIEW_INVALID_INPUT,
        getErrorMessage(ErrorCode.REVIEW_INVALID_INPUT, "상품 리뷰는 상품 선택이 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
        correlationId,
      );
    }

    const productId =
      validated.placement === "homepage"
        ? await resolveHomepageReviewAnchorProductId(shop)
        : validated.productId!.trim();

    logEvent(
      "review.admin.create.attempt",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        productId,
        placement: validated.placement,
        bodyLength: validated.body.length,
      },
      { correlationId, shop },
    );

    const { label } = await getAdminReviewLabel();

    const created = await createAdminReviewMetaobject({
      shop,
      productId,
      body: validated.body,
      label,
      authorDisplayName: validated.authorDisplayName || "운영팀",
      placement: validated.placement,
    });

    logEvent(
      "review.admin.create.success",
      {
        path: new URL(request.url).pathname,
        method: "POST",
        productId,
        placement: validated.placement,
        label,
        reviewId: created.id,
        durationMs: Date.now() - startTime,
      },
      { correlationId, shop },
    );

    return respond.ok({ item: created }, { correlationId });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues.map((issue) => issue.message).join(", ");
      logEvent(
        "review.admin.create.fail",
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
        "review.admin.create.fail",
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
      "review.admin.create.fail",
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
