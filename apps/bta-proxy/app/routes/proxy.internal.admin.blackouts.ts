import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import {
  parseQueryParams,
  globalBlackoutListSchema,
  globalBlackoutCreateSchema,
} from "~/lib/validation";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  getAdminApiClient,
  listGlobalBlackouts,
  listGlobalBlackoutRecordsByDate,
  createGlobalBlackout,
  deleteGlobalBlackout,
} from "~/lib/shopifyAdmin";
import { logEvent } from "~/lib/logEvent";

async function resolveAdminClient(shop: string) {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }
  return admin;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  try {
    const url = new URL(request.url);
    const queryParams = parseQueryParams(url);
    const validatedInput = globalBlackoutListSchema.parse(queryParams);

    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin: Awaited<ReturnType<typeof resolveAdminClient>> | null = null;

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

    const result = await listGlobalBlackouts({
      admin,
      shop,
      from: validatedInput.from,
      to: validatedInput.to,
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

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  if (request.method.toUpperCase() !== "POST") {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const validatedInput = globalBlackoutCreateSchema.parse(body);
    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin: Awaited<ReturnType<typeof resolveAdminClient>> | null = null;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) {
        return authResponse;
      }

      shop = validatedInput.shop || null;
      if (!shop) {
        const url = new URL(request.url);
        shop = url.searchParams.get("shop");
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

    const existing = await listGlobalBlackoutRecordsByDate({
      admin,
      shop,
      date: validatedInput.date,
    });
    if (existing.length > 0) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "이미 등록된 날짜입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const created = await createGlobalBlackout({
      admin,
      shop,
      date: validatedInput.date,
      note: validatedInput.note,
    });

    const afterCreate = await listGlobalBlackoutRecordsByDate({
      admin,
      shop,
      date: validatedInput.date,
    });
    const duplicates = afterCreate.filter((item) => item.id !== created.id);
    if (duplicates.length > 0) {
      await Promise.all(
        duplicates.map((record) => deleteGlobalBlackout({ admin, shop, id: record.id })),
      );
    }

    logEvent(
      "blackout.created",
      { blackoutId: created.id, date: created.date },
      { correlationId, shop, severity: "info" },
    );

    return respond.ok(
      {
        action: "created",
        item: created,
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
