import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";

export function verifyAdminApiKey(request: Request): Response | null {
  const correlationId = respond.getCorrelationId(request);
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR, "ADMIN_API_KEY 환경변수가 설정되지 않았습니다."),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }

  const provided = request.headers.get("X-Admin-Api-Key");
  if (!provided || provided !== expected) {
    return respond.fail(
      ErrorCode.INTERNAL_AUTH_INVALID,
      getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID, "관리자 인증에 실패했습니다."),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
      correlationId,
    );
  }

  return null;
}
