import { randomBytes } from "crypto";
import { redirect, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  buildInstagramAuthorizeUrl,
} from "~/lib/instagram/client";
import {
  ensureInstagramOAuthConfig,
  getInstagramConfig,
  isInstagramShopAllowed,
} from "~/lib/instagram/env";
import { saveInstagramOAuthState } from "~/lib/instagram/store";
import { normalizeShopDomain } from "~/lib/shopifySession";

const querySchema = z.object({
  shop: z.string().trim().min(1, "shop is required"),
  returnTo: z.string().trim().optional(),
});

function normalizeShop(shopRaw: string): string | null {
  const normalized = normalizeShopDomain(shopRaw);
  if (!normalized) return null;
  if (normalized.includes(".")) return normalized;
  return `${normalized}.myshopify.com`;
}

function sanitizeReturnTo(returnToRaw?: string): string | null {
  if (!returnToRaw) return null;
  const returnTo = returnToRaw.trim();
  if (!returnTo) return null;
  if (!returnTo.startsWith("/")) return null;
  if (returnTo.startsWith("//")) return null;
  return returnTo;
}

/**
 * GET /proxy/instagram/oauth/start
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  try {
    const url = new URL(request.url);
    const validated = querySchema.parse({
      shop: url.searchParams.get("shop") || "",
      returnTo: url.searchParams.get("returnTo") || undefined,
    });

    const shop = normalizeShop(validated.shop);
    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터 형식이 올바르지 않습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const config = getInstagramConfig();
    ensureInstagramOAuthConfig(config);

    if (!isInstagramShopAllowed(shop, config)) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "허용되지 않은 shop입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const state = randomBytes(32).toString("hex");
    const returnTo = sanitizeReturnTo(validated.returnTo);

    await saveInstagramOAuthState(
      state,
      {
        shop,
        returnTo,
        createdAt: new Date().toISOString(),
      },
      config.stateTtlSec
    );

    const authorizeUrl = buildInstagramAuthorizeUrl(state);
    return redirect(authorizeUrl, {
      headers: {
        "X-Correlation-Id": correlationId,
      },
    });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((issue) => issue.message).join(", ")
        ),
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
