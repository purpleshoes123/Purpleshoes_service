import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import {
  getCustomerEntitlements,
  listLedgerEvents,
  type EntitlementType,
} from "~/lib/guideExtension";
import db from "~/db.server";
import { listLogs } from "~/lib/guideExtension/logStore";

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
    previousExpiresAt: log.previousExpiresAt
      ? log.previousExpiresAt.toISOString()
      : null,
    newExpiresAt: log.newExpiresAt ? log.newExpiresAt.toISOString() : null,
    createdAt: log.createdAt.toISOString(),
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);

  try {
    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin: Awaited<ReturnType<typeof getAdminApiClient>> | null = null;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) return authResponse;

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
      admin = await getAdminApiClient(shop);
    } else {
      const auth = await authenticate.admin(request);
      shop = auth.session.shop;
      admin = auth.admin;
    }

    if (!shop || !admin) {
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

    const customerParam = params.customerId;
    if (!customerParam) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId는 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const customerId = normalizeCustomerId(customerParam);
    const entitlements = await getCustomerEntitlements(admin, customerId);

    const types: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];
    const ledger: Record<string, unknown> = {};
    for (const type of types) {
      ledger[type] = await listLedgerEvents(admin, { customerId, type });
    }

    const logs = await listLogs(db, {
      filters: { shop, customerId },
      limit: 50,
    });

    return respond.ok(
      {
        customerId,
        entitlements,
        ledger,
        logs: logs.logs.map(serializeLog),
        nextCursor: logs.nextCursor,
      },
      { correlationId }
    );
  } catch (error) {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
