import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import {
  enforceStorefrontCustomerRateLimit,
  getStorefrontRateLimitMode,
} from "~/lib/rateLimit/storefrontCustomerRateLimit.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import {
  extractCustomerIdFromProxyRequest,
  getCustomerEntitlements,
  GUIDE_EXTENSION_TYPES,
  isActive,
  listLedgerEvents,
  normalizeToKstEndOfDay,
} from "~/domains/checkout/guideExtension";

type EntitlementStatus = "ACTIVE" | "EXPIRED" | "NONE";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function nowKstIso(): string {
  const now = new Date();
  const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);
  return `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(
    kst.getUTCDate(),
  )}T${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}:${pad2(kst.getUTCSeconds())}+09:00`;
}

/**
 * SSOT: GET /proxy/bta/guide-extension/entitlements
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const storefrontRateLimitMode = getStorefrontRateLimitMode();
  // Keep the legacy rate-limit/auth ordering when v2 is disabled so the
  // feature flag remains a complete operational rollback.
  if (storefrontRateLimitMode === "off") {
    const rateLimitResponse = await enforceRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }
  }

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) {
    return verifyResponse;
  }

  const correlationId = respond.getCorrelationId(request);

  try {
    const shop = extractShopFromRequest(request);
    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const customerId = extractCustomerIdFromProxyRequest(request);
    if (!customerId) {
      return respond.fail(
        ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE,
        "로그인 상태를 확인할 수 없습니다. 다시 로그인 후 시도해주세요.",
        undefined,
        getErrorStatus(ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE),
        correlationId,
      );
    }

    if (storefrontRateLimitMode !== "off") {
      const rateLimitResponse = await enforceStorefrontCustomerRateLimit({
        shop,
        customerId,
        bucket: "mypage-read",
        path: new URL(request.url).pathname,
        correlationId,
      });
      if (rateLimitResponse) {
        return rateLimitResponse;
      }
    }

    const admin = await getAdminApiClient(shop);
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

    const entitlements = await getCustomerEntitlements(admin, customerId);
    const now = new Date();

    // The entitlement metafield tells us the current expiry, while the ledger
    // is the source for the customer's most recent paid extension. Surface
    // both so the thank-you page can describe the actual extension just
    // purchased instead of guessing from the remaining access period.
    const latestExtensionMonthsByType = new Map<string, number>();
    await Promise.all(
      GUIDE_EXTENSION_TYPES.map(async (type) => {
        try {
          const latest = (await listLedgerEvents(admin, { customerId, type }))
            .filter((event) => event.eventType === "EXTEND" && event.months > 0)
            .sort(
              (left, right) =>
                new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime(),
            )[0];

          if (latest) {
            latestExtensionMonthsByType.set(type, latest.months);
          }
        } catch (error) {
          // Ledger data may be unavailable for older customers. The current
          // entitlement is still valid and is enough to render access status.
          console.warn(
            JSON.stringify({
              message: "Guide extension ledger lookup failed",
              customerId,
              type,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }),
    );

    const items = GUIDE_EXTENSION_TYPES.map((type) => {
      const rawValue = entitlements[type] ?? null;
      const extensionMonths = latestExtensionMonthsByType.get(type) ?? null;
      const extensionDays = extensionMonths ? extensionMonths * 30 : null;
      if (!rawValue) {
        return {
          type,
          expiresAtKst: null,
          status: "NONE" as EntitlementStatus,
          extensionMonths,
          extensionDays,
        };
      }

      try {
        const normalized = normalizeToKstEndOfDay(rawValue);
        const status: EntitlementStatus = isActive(normalized, now) ? "ACTIVE" : "EXPIRED";
        return {
          type,
          expiresAtKst: normalized,
          status,
          extensionMonths,
          extensionDays,
        };
      } catch {
        return {
          type,
          expiresAtKst: null,
          status: "NONE" as EntitlementStatus,
          extensionMonths,
          extensionDays,
        };
      }
    });

    const bundleItem = items.find((item) => item.type === "BUNDLE");
    const bundleActive = bundleItem?.status === "ACTIVE";

    const responseDTO = {
      customer: { id: customerId },
      nowKst: nowKstIso(),
      items,
      uiHints: {
        pdfAccessViaBundle: Boolean(bundleActive),
        videoAccessViaBundle: Boolean(bundleActive),
      },
      eligible: items.some((item) => item.status === "ACTIVE"),
    };

    return respond.ok(responseDTO, { correlationId });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Guide extension entitlements error",
        error: error instanceof Error ? error.message : String(error),
      }),
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
