import type { ActionFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { verifyAdminApiKey } from "~/middleware/verifyAdminApiKey";
import { reconcileSchema } from "~/domains/coupons/validation";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { normalizeCustomerId } from "~/domains/coupons/normalize";
import { reconcileCustomerCoupons } from "~/domains/coupons/reconcile";

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return undefined;
}

/**
 * POST /admin/coupons/reconcile
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifyAdminApiKey(request);
  if (authResponse) {
    return authResponse;
  }

  try {
    const url = new URL(request.url);
    const queryCustomerId = url.searchParams.get("customerId") || undefined;
    const queryDryRun = parseBool(url.searchParams.get("dryRun"));

    let body: Record<string, any> = {};
    const bodyText = await request.text();
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as Record<string, any>;
      } catch {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "JSON body 파싱에 실패했습니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }
    }

    const candidate = {
      customerId: queryCustomerId || body.customerId,
      dryRun: queryDryRun ?? parseBool(body.dryRun),
    };

    const validated = reconcileSchema.parse(candidate);
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

    const dryRun = validated.dryRun ?? true;
    const report = await reconcileCustomerCoupons(admin, customerId, dryRun);

    return respond.ok(
      {
        ok: true,
        customerId,
        dryRun,
        report,
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
