import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { parseQueryParams, adminCalendarSchema } from "~/lib/validation";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { listAdminCalendar } from "~/domains/bookings/adminCalendarService";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  try {
    const url = new URL(request.url);
    const queryParams = parseQueryParams(url);
    const validatedInput = adminCalendarSchema.parse(queryParams);

    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin = undefined;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) {
        return authResponse;
      }

      shop = validatedInput.shop || url.searchParams.get("shop");
      if (!shop) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }

      if (!shop.includes(".")) {
        shop = `${shop}.myshopify.com`;
      }
    } else {
      try {
        const auth = await authenticate.admin(request);
        shop = auth.session.shop;
        admin = auth.admin;
      } catch (error) {
        if (error instanceof Response) {
          return respond.fail(
            ErrorCode.INTERNAL_AUTH_INVALID,
            getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID),
            undefined,
            getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
            correlationId,
          );
        }
        throw error;
      }
    }

    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const result = await listAdminCalendar({
      shop,
      from: validatedInput.from,
      to: validatedInput.to,
      poolKey: validatedInput.poolKey,
      productId: validatedInput.productId,
      admin,
    });

    return respond.ok(result, { correlationId });
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

    const message = error instanceof Error ? error.message : String(error);
    if (message === "REDIS_BOOKING_STORE_REQUIRED") {
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(ErrorCode.INTERNAL_ERROR, "Redis Booking Store가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
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
