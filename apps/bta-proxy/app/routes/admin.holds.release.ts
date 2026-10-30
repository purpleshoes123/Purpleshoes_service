import type { ActionFunctionArgs } from "react-router";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { adminHoldReleaseSchema } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { maskPII } from "~/lib/masking";

/**
 * Phase 4: POST /admin/holds/release
 * 내부 인증 (X-Internal-Token)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  const authResponse = await verifyInternal(request);
  if (authResponse) {
    return authResponse;
  }

  try {
    const body = await request.json();
    const validated = adminHoldReleaseSchema.parse(body);
    const dryRun = validated.dryRun === true;

    if (dryRun) {
      return respond.ok(
        {
          holdId: validated.holdId,
          released: false,
          dryRun: true,
          reason: validated.reason || null,
        },
        { correlationId },
      );
    }

    const store = getBookingStore();
    try {
      await store.releaseHold(validated.holdId);
      return respond.ok(
        {
          holdId: validated.holdId,
          released: true,
          dryRun: false,
          reason: validated.reason || null,
        },
        { correlationId },
      );
    } catch (releaseError) {
      if (releaseError instanceof Error) {
        const normalized = releaseError.message.toLowerCase();
        if (
          normalized.includes("not found") ||
          normalized.includes("already released") ||
          normalized.includes("404")
        ) {
          return respond.ok(
            {
              holdId: validated.holdId,
              released: true,
              dryRun: false,
              reason: "ALREADY_RELEASED",
            },
            { correlationId },
          );
        }
        if (releaseError.message.includes("timeout") || releaseError.name === "TimeoutError") {
          return respond.fail(
            ErrorCode.BOOKING_STORE_TIMEOUT,
            getErrorMessage(ErrorCode.BOOKING_STORE_TIMEOUT),
            undefined,
            getErrorStatus(ErrorCode.BOOKING_STORE_TIMEOUT),
            correlationId,
          );
        }

        return respond.fail(
          ErrorCode.BOOKING_STORE_ERROR,
          getErrorMessage(ErrorCode.BOOKING_STORE_ERROR),
          undefined,
          getErrorStatus(ErrorCode.BOOKING_STORE_ERROR),
          correlationId,
        );
      }

      throw releaseError;
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

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

    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Admin hold release error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
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
