import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import db from "~/db.server";
import { getLogById } from "~/lib/guideExtension/logStore";

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
        correlationId
      );
    }

    const logId = params.id;
    if (!logId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "log id는 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const log = await getLogById(db, logId);
    if (!log || log.shop !== shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "log를 찾을 수 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    return respond.ok(serializeLog(log), { correlationId });
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
