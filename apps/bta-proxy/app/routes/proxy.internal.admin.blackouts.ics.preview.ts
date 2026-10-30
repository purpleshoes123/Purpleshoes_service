import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { listGlobalBlackouts, getAdminApiClient } from "~/lib/shopifyAdmin";
import { parseIcsToDates, isIcsParseError } from "~/domains/bookings/icsParser";

async function resolveAdminClient(shop: string) {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }
  return admin;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  try {
    let icsText = "";
    let includePast = false;
    let from: string | undefined;
    let to: string | undefined;

    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "ICS 파일이 필요합니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }
      icsText = await (file as File).text();
      includePast = formData.get("includePast") === "true";
      const formFrom = formData.get("from");
      const formTo = formData.get("to");
      if (typeof formFrom === "string") {
        from = formFrom;
      }
      if (typeof formTo === "string") {
        to = formTo;
      }
    } else {
      const body = await request.json();
      icsText = body?.ics || "";
      includePast = body?.includePast === true;
      from = body?.from;
      to = body?.to;
    }

    if (!icsText) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "ICS 내용이 비어 있습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin: Awaited<ReturnType<typeof resolveAdminClient>> | null = null;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) {
        return authResponse;
      }

      const url = new URL(request.url);
      shop = url.searchParams.get("shop");
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

      admin = await resolveAdminClient(shop);
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

    if (!admin || !shop) {
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

    const parsed = parseIcsToDates(icsText, { includePast, from, to });
    const expandedDates = parsed.expandedDates;
    const warnings = parsed.warnings;

    let existingDates: string[] = [];
    if (expandedDates.length > 0) {
      const minDate = expandedDates[0];
      const maxDate = expandedDates[expandedDates.length - 1];
      const existing = await listGlobalBlackouts({
        admin,
        shop,
        from: minDate,
        to: maxDate,
      });
      existingDates = existing.dates;
    }

    const existingSet = new Set(existingDates);
    const toCreateDates = expandedDates.filter((date) => !existingSet.has(date));
    const dateNotes: Record<string, string> = {};
    for (const date of toCreateDates) {
      if (parsed.dateNotes[date]) {
        dateNotes[date] = parsed.dateNotes[date];
      }
    }

    return respond.ok(
      {
        calendarTitle: parsed.calendarTitle || null,
        expandedDates,
        existingDates,
        toCreateDates,
        dateNotes,
        warnings,
        stats: {
          eventsParsed: parsed.eventsParsed,
          datesExpanded: expandedDates.length,
          datesExisting: existingDates.length,
          datesNew: toCreateDates.length,
        },
      },
      { correlationId },
    );
  } catch (error) {
    if (isIcsParseError(error)) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, error.message),
        undefined,
        error.status,
        correlationId,
      );
    }
    if (error instanceof SyntaxError) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 요청 형식입니다."),
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
