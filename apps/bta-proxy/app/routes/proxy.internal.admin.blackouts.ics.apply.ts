import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { createGlobalBlackout, listGlobalBlackouts, getAdminApiClient } from "~/lib/shopifyAdmin";
import { logEvent } from "~/lib/logEvent";
import { parseQueryParams } from "~/lib/validation";

type ApplyBody = {
  dates: string[];
  note?: string;
  calendarTitle?: string;
  dateNotes?: Record<string, string>;
};

async function resolveAdminClient(shop: string) {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }
  return admin;
}

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  try {
    const body = (await request.json()) as ApplyBody;
    const dates = Array.isArray(body?.dates) ? body.dates : [];
    if (dates.length === 0) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "날짜 목록이 비어 있습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }
    if (!dates.every((date) => dateRegex.test(date))) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "날짜는 YYYY-MM-DD 형식이어야 합니다."),
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
      const queryParams = parseQueryParams(url);
      shop = (queryParams.shop as string) || url.searchParams.get("shop");
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

    const sortedDates = Array.from(new Set(dates)).sort();
    const minDate = sortedDates[0];
    const maxDate = sortedDates[sortedDates.length - 1];
    const existing = await listGlobalBlackouts({
      admin,
      shop,
      from: minDate,
      to: maxDate,
    });
    const existingSet = new Set(existing.dates);

    const createdDates: string[] = [];
    for (const date of sortedDates) {
      if (existingSet.has(date)) {
        continue;
      }
      const note =
        (body.dateNotes && body.dateNotes[date]) || body.note || body.calendarTitle || undefined;
      await createGlobalBlackout({
        admin,
        shop,
        date,
        note,
        source: "ics",
      });
      createdDates.push(date);
    }

    const skippedCount = sortedDates.length - createdDates.length;
    logEvent(
      "blackout.ics.apply",
      { createdCount: createdDates.length, skippedCount },
      { correlationId, shop, severity: "info" },
    );

    return respond.ok(
      {
        createdCount: createdDates.length,
        skippedCount,
        createdDates,
      },
      { correlationId },
    );
  } catch (error) {
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
