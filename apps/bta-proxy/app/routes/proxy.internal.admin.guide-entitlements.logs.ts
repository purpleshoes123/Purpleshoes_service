import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import db from "~/db.server";
import {
  listLogs,
  type GuideEntitlementLogStatus,
} from "~/domains/checkout/guideExtension/logStore";

function normalizeCustomerId(value: string): string {
  if (value.startsWith("gid://")) {
    return value;
  }
  if (/^\d+$/.test(value)) {
    return `gid://shopify/Customer/${value}`;
  }
  return value;
}

function serializeLog(log: any) {
  return {
    ...log,
    baseExpiresAt: log.baseExpiresAt ? log.baseExpiresAt.toISOString() : null,
    previousExpiresAt: log.previousExpiresAt ? log.previousExpiresAt.toISOString() : null,
    newExpiresAt: log.newExpiresAt ? log.newExpiresAt.toISOString() : null,
    createdAt: log.createdAt.toISOString(),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);

  try {
    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) {
        return authResponse;
      }

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
    } else {
      const auth = await authenticate.admin(request);
      shop = auth.session.shop;
    }

    if (!shop) {
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(ErrorCode.INTERNAL_ERROR),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId,
      );
    }

    const limitRaw = url.searchParams.get("limit") || "50";
    let limit = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(limit) || limit < 1) {
      limit = 50;
    }
    if (limit > 200) {
      limit = 200;
    }

    const cursor = url.searchParams.get("cursor");
    const customerIdParam = url.searchParams.get("customerId");
    const filters = {
      shop,
      customerId: customerIdParam ? normalizeCustomerId(customerIdParam) : undefined,
      orderId: url.searchParams.get("orderId") || undefined,
      refundId: url.searchParams.get("refundId") || undefined,
      status: (url.searchParams.get("status") as GuideEntitlementLogStatus | null) || undefined,
      entitlementType: url.searchParams.get("entitlementType") || undefined,
      eventType: url.searchParams.get("eventType") || undefined,
      topic: url.searchParams.get("topic") || undefined,
    };

    const result = await listLogs(db, {
      filters,
      limit,
      cursor,
    });

    return respond.ok(
      {
        logs: result.logs.map(serializeLog),
        nextCursor: result.nextCursor,
      },
      { correlationId },
    );
  } catch (error) {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
