import type { ActionFunctionArgs } from "react-router";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import {
  MailerServiceError,
  submitStorefrontMailRequest,
} from "~/lib/mailer/service.server";
import { parseStorefrontMailRequestBody } from "~/lib/mailer/requestBody.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { maskPII } from "~/lib/masking";
import { respond } from "~/lib/respond";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import { createLeadReceipt } from "~/lib/marketing/leadReceipt.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  const correlationId = respond.getCorrelationId(request);

  try {
    const shopDomain = extractShopFromRequest(request);
    if (!shopDomain) {
      return respond.fail(
        ErrorCode.MAILER_INVALID_INPUT,
        getErrorMessage(
          ErrorCode.MAILER_INVALID_INPUT,
          "shop 파라미터가 필요합니다."
        ),
        undefined,
        getErrorStatus(ErrorCode.MAILER_INVALID_INPUT),
        correlationId
      );
    }

    const input = await parseStorefrontMailRequestBody(request);
    const result = await submitStorefrontMailRequest({
      shopDomain,
      input,
      request,
    });

    // The browser receives a short-lived receipt, not a Lead event. It may
    // redeem the receipt only after reaching the squeeze thank-you page.
    const leadReceipt = input.templateSlug.trim().toLowerCase() === "squeeze" &&
      input.metaMarketingAllowed && !result.duplicate
      ? createLeadReceipt(result.requestId, shopDomain)
      : undefined;

    return respond.withNoStore(respond.ok(
      {
        message: "메일이 발송되었습니다.",
        requestId: result.requestId,
        duplicate: result.duplicate,
        sentAt: result.sentAt,
        leadReceipt,
      },
      { correlationId }
    ));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return respond.fail(
        ErrorCode.MAILER_INVALID_INPUT,
        getErrorMessage(
          ErrorCode.MAILER_INVALID_INPUT,
          "잘못된 JSON 형식입니다."
        ),
        undefined,
        getErrorStatus(ErrorCode.MAILER_INVALID_INPUT),
        correlationId
      );
    }

    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.MAILER_INVALID_INPUT,
        getErrorMessage(
          ErrorCode.MAILER_INVALID_INPUT,
          zodError.issues.map((issue) => issue.message).join(", ")
        ),
        undefined,
        getErrorStatus(ErrorCode.MAILER_INVALID_INPUT),
        correlationId
      );
    }

    if (
      error instanceof TypeError &&
      error.message.includes("Content-Type")
    ) {
      return respond.fail(
        ErrorCode.MAILER_INVALID_INPUT,
        getErrorMessage(ErrorCode.MAILER_INVALID_INPUT, error.message),
        undefined,
        getErrorStatus(ErrorCode.MAILER_INVALID_INPUT),
        correlationId
      );
    }

    if (error instanceof MailerServiceError) {
      return respond.fail(
        error.code,
        getErrorMessage(error.code, error.message),
        error.details,
        getErrorStatus(error.code),
        correlationId
      );
    }

    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Storefront mail request failed",
          error: error instanceof Error ? error.message : String(error),
        })
      )
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
