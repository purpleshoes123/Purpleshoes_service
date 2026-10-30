import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { authenticate } from "~/shopify.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { recomputeEntitlement, type RecomputeOutcome } from "~/domains/checkout/guideExtension";
import db from "~/db.server";
import { createLog } from "~/domains/checkout/guideExtension/logStore";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 3;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

const recomputeSchema = z.object({
  customerId: z
    .string()
    .regex(/^gid:\/\/shopify\/Customer\/\d+$/, "customerId는 GID 형식이어야 합니다."),
  types: z.array(z.enum(["PDF", "VIDEO", "BUNDLE"])).min(1, "types는 최소 1개 이상이어야 합니다."),
  reason: z.string().max(200, "reason은 200자 이하여야 합니다.").optional(),
});

function checkRateLimit(key: string): { ok: boolean; retryAfter?: number } {
  const now = Date.now();
  const current = rateLimitMap.get(key);
  if (!current || now > current.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { ok: true };
  }
  if (current.count >= RATE_LIMIT_MAX) {
    return { ok: false, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  }
  current.count += 1;
  rateLimitMap.set(key, current);
  return { ok: true };
}

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
    const auth = await authenticate.admin(request);
    const shop = auth.session.shop;

    let body: unknown = {};
    try {
      body = await request.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }
      throw error;
    }

    const validated = recomputeSchema.parse(body);
    const rateKey = `${shop}:${validated.customerId}`;
    const rate = checkRateLimit(rateKey);
    if (!rate.ok) {
      return respond.fail(
        ErrorCode.RATE_LIMITED,
        getErrorMessage(ErrorCode.RATE_LIMITED),
        rate.retryAfter ? { retryAfterSec: rate.retryAfter } : undefined,
        getErrorStatus(ErrorCode.RATE_LIMITED),
        correlationId,
      );
    }

    const results: Array<{
      type: string;
      baseExpiresAt?: string | null;
      netMonths?: number;
      newExpiresAt?: string | null;
      status: "SUCCESS" | "FAILED";
      outcome?: RecomputeOutcome | "FAILED_NO_CHANGE";
      error?: string;
    }> = [];

    for (const type of validated.types) {
      try {
        const recomputeResult = await recomputeEntitlement({
          admin: auth.admin,
          customerId: validated.customerId,
          type,
          reason: validated.reason || "manual recompute by admin",
        });

        await createLog(db, {
          shop,
          topic: "ADMIN_ACTION",
          customerId: validated.customerId,
          entitlementType: type,
          eventType: "RECOMPUTE",
          monthsDelta: 0,
          baseExpiresAt: recomputeResult.baseExpiresAt,
          newExpiresAt: recomputeResult.newExpiresAt,
          status: "SUCCESS",
          rawRef: correlationId,
        });

        results.push({
          type,
          baseExpiresAt: recomputeResult.baseExpiresAt,
          netMonths: recomputeResult.netMonths,
          newExpiresAt: recomputeResult.newExpiresAt,
          status: "SUCCESS",
          outcome: recomputeResult.outcome,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await createLog(db, {
          shop,
          topic: "ADMIN_ACTION",
          customerId: validated.customerId,
          entitlementType: type,
          eventType: "RECOMPUTE",
          monthsDelta: 0,
          status: "FAILED",
          errorCode: "ADMIN_RECOMPUTE_FAILED",
          errorMessage: message,
          rawRef: correlationId,
        });

        results.push({
          type,
          status: "FAILED",
          outcome: "FAILED_NO_CHANGE",
          error: message,
        });
      }
    }

    return respond.ok({ results }, { correlationId });
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
