import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  getCustomerEntitlements,
  isActive,
  normalizeToKstEndOfDay,
  type EntitlementType,
} from "~/domains/checkout/guideExtension";
import db from "~/db.server";
import { listLogs } from "~/domains/checkout/guideExtension/logStore";

type EntitlementStatus = "ACTIVE" | "EXPIRED" | "NONE";

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

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  try {
    const auth = await authenticate.admin(request);
    const customerParam = params.customerId;
    if (!customerParam) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId는 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const customerId = normalizeCustomerId(customerParam);
    const entitlements = await getCustomerEntitlements(auth.admin, customerId);
    const now = new Date();
    const types: EntitlementType[] = ["PDF", "VIDEO", "BUNDLE"];

    const items = types.map((type) => {
      const rawValue = entitlements[type] ?? null;
      if (!rawValue) {
        return { type, expiresAtKst: null, status: "NONE" as EntitlementStatus };
      }

      try {
        const normalized = normalizeToKstEndOfDay(rawValue);
        const status: EntitlementStatus = isActive(normalized, now) ? "ACTIVE" : "EXPIRED";
        return { type, expiresAtKst: normalized, status };
      } catch {
        return { type, expiresAtKst: null, status: "NONE" as EntitlementStatus };
      }
    });

    const logs = await listLogs(db, {
      filters: { shop: auth.session.shop, customerId },
      limit: 5,
    });

    return respond.ok(
      {
        customerId,
        items,
        logs: logs.logs.map(serializeLog),
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
