import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { adminRefundSchema } from "~/lib/validation";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getOrderRefundInfo } from "~/lib/adminOrderService";
import { createRefundGraphQL, getAdminApiClient } from "~/lib/shopifyAdmin";
import { getRedisBookingClient } from "~/lib/bookingStore";
import { logEvent } from "~/lib/logEvent";

const ATTEMPT_TTL_MS = 60 * 60 * 1000;
const inMemoryAttempts = new Map<string, number>();

async function resolveAdminClient(shop: string) {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }
  return admin;
}

async function isDuplicateAttempt(
  redisClient: any | null,
  key: string
): Promise<boolean> {
  if (redisClient) {
    const exists = await redisClient.get(key);
    return Boolean(exists);
  }
  const now = Date.now();
  const expiresAt = inMemoryAttempts.get(key);
  if (expiresAt && expiresAt > now) {
    return true;
  }
  return false;
}

async function markAttempt(
  redisClient: any | null,
  key: string
): Promise<void> {
  if (redisClient) {
    await redisClient.set(key, "1", "PX", ATTEMPT_TTL_MS);
    return;
  }
  inMemoryAttempts.set(key, Date.now() + ATTEMPT_TTL_MS);
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authRequest = request.clone();
  const orderId = params.orderId;
  if (!orderId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "orderId는 필수입니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  try {
    const body = await request.json();
    const validatedInput = adminRefundSchema.parse(body);

    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin: Awaited<ReturnType<typeof resolveAdminClient>> | null = null;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) return authResponse;

      const url = new URL(request.url);
      shop = url.searchParams.get("shop");
      if (!shop) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
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
            correlationId
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
          "Shopify Admin API 세션을 찾을 수 없습니다."
        ),
        undefined,
        getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
        correlationId
      );
    }

    const redisClient = getRedisBookingClient();
    const attemptKey = `refund:attempt:${shop}:${orderId}:${validatedInput.refundAttemptId}`;
    if (await isDuplicateAttempt(redisClient, attemptKey)) {
      return respond.ok(
        {
          status: "duplicate",
          mode: validatedInput.mode,
        },
        { correlationId }
      );
    }

    const refundInfo = await getOrderRefundInfo({
      shop,
      orderId,
      admin,
    });
    if (!refundInfo) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "orderId를 찾을 수 없습니다."),
        undefined,
        404,
        correlationId
      );
    }

    const lineItemMap = new Map(
      refundInfo.lineItems.map((item) => [item.lineItemId, item])
    );

    let refundLineItems: Array<{ lineItemId: string; quantity: number }> = [];
    if (validatedInput.mode === "full") {
      refundLineItems = refundInfo.lineItems.map((item) => ({
        lineItemId: item.lineItemId,
        quantity: item.quantity,
      }));
    } else {
      refundLineItems = (validatedInput.items || []).map((item) => ({
        lineItemId: item.lineItemId,
        quantity: item.quantity,
      }));
    }

    if (refundLineItems.length === 0) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "환불 대상이 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    for (const item of refundLineItems) {
      const purchased = lineItemMap.get(item.lineItemId);
      if (!purchased) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "lineItemId가 유효하지 않습니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
        );
      }
      if (item.quantity > purchased.quantity) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            "환불 수량이 구매 수량을 초과했습니다."
          ),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
        );
      }
    }

    const refundResult = await createRefundGraphQL(admin, {
      orderId: refundInfo.orderGid,
      refundLineItems,
      note: "Admin refund",
      notify: false,
    });

    if (refundResult.userErrors.length > 0) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          refundResult.userErrors.join(", ")
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    await markAttempt(redisClient, attemptKey);
    logEvent(
      "refund.created",
      {
        orderId,
        refundId: refundResult.refundId,
        mode: validatedInput.mode,
        lineItemCount: refundLineItems.length,
      },
      { correlationId, shop, severity: "info" }
    );

    return respond.ok(
      {
        status: "created",
        refundId: refundResult.refundId,
        mode: validatedInput.mode,
      },
      { correlationId }
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues
        .map((issue) => issue.message)
        .join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
