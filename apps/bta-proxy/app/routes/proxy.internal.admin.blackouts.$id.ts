import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { globalBlackoutUpdateSchema } from "~/lib/validation";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  getAdminApiClient,
  deleteGlobalBlackout,
  updateGlobalBlackoutNote,
} from "~/lib/shopifyAdmin";
import { logEvent } from "~/lib/logEvent";

async function resolveAdminClient(shop: string) {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }
  return admin;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authRequest = request.clone();
  const method = request.method.toUpperCase();
  const rawId = params.id;
  let blackoutId = rawId || "";
  try {
    if (rawId && rawId.includes("%")) {
      blackoutId = decodeURIComponent(rawId);
    }
  } catch {
    blackoutId = rawId || "";
  }

  if (!blackoutId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "id는 필수입니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  if (method !== "PATCH" && method !== "DELETE") {
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
    if (method === "PATCH") {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    }

    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin: Awaited<ReturnType<typeof resolveAdminClient>> | null = null;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) {
        return authResponse;
      }

      if (method === "PATCH") {
        const validatedInput = globalBlackoutUpdateSchema.parse(body);
        shop = validatedInput.shop || null;
      }
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
        const auth = await authenticate.admin(authRequest);
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

    if (method === "DELETE") {
      await deleteGlobalBlackout({ admin, shop, id: blackoutId });
      logEvent("blackout.deleted", { blackoutId }, { correlationId, shop, severity: "info" });
      return respond.ok(
        {
          action: "deleted",
          id: blackoutId,
        },
        { correlationId },
      );
    }

    const validatedInput = globalBlackoutUpdateSchema.parse(body);
    const updated = await updateGlobalBlackoutNote({
      admin,
      shop,
      id: blackoutId,
      note: validatedInput.note ?? "",
    });

    logEvent(
      "blackout.updated",
      { blackoutId: updated.id, date: updated.date },
      { correlationId, shop, severity: "info" },
    );

    return respond.ok(
      {
        action: "updated",
        item: updated,
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
