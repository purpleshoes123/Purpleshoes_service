import type { ActionFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { verifyAdminApiKey } from "~/middleware/verifyAdminApiKey";
import { adminIssueSchema } from "~/domains/coupons/validation";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { issueGuide50, issueExtra10 } from "~/domains/coupons/issuer";
import { normalizeCustomerId } from "~/domains/coupons/normalize";
import { acquireLock, releaseLock } from "~/domains/coupons/lock";

/**
 * POST /admin/coupons/issue
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifyAdminApiKey(request);
  if (authResponse) {
    return authResponse;
  }

  try {
    const body = await request.json();
    const validated = adminIssueSchema.parse(body);
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

    const lockOk = await acquireLock("adminIssue", customerId, 20);
    if (!lockOk) {
      return respond.fail(
        ErrorCode.INTERNAL_CONFLICT,
        getErrorMessage(ErrorCode.INTERNAL_CONFLICT),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_CONFLICT),
        correlationId,
      );
    }

    try {
      const url = new URL(request.url);
      const shop = url.searchParams.get("shop") || body.shop;
      if (!shop) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }

      const admin = await getAdminApiClient(shop);
      if (!admin) {
        return respond.fail(
          ErrorCode.SHOPIFY_ADMIN_API_ERROR,
          getErrorMessage(
            ErrorCode.SHOPIFY_ADMIN_API_ERROR,
            "Shopify Admin API 세션을 찾을 수 없습니다.",
          ),
          undefined,
          getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
          correlationId,
        );
      }

      if (validated.couponKind === "GUIDE50") {
        const result = await issueGuide50(admin, customerId);
        return respond.ok(
          {
            ok: true,
            couponKind: validated.couponKind,
            code: result.code,
            issued: result.issued,
            reason: result.reason,
          },
          { correlationId },
        );
      }

      if (validated.couponKind === "EXTRA10") {
        const result = await issueExtra10(admin, customerId);
        return respond.ok(
          {
            ok: true,
            couponKind: validated.couponKind,
            code: result.code,
            issued: result.issued,
            reason: result.reason,
          },
          { correlationId },
        );
      }

      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          `couponKind ${validated.couponKind} 지원되지 않습니다.`,
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    } finally {
      await releaseLock("adminIssue", customerId);
    }
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
