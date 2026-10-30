import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";

export function verifyInternalEvent(request: Request): Response | null {
  const correlationId = respond.getCorrelationId(request);
  const expected = process.env.INTERNAL_EVENT_TOKEN;
  if (!expected) {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(
        ErrorCode.INTERNAL_ERROR,
        "INTERNAL_EVENT_TOKEN 환경변수가 설정되지 않았습니다.",
      ),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }

  const provided = request.headers.get("X-Internal-Event-Token");
  if (!provided || provided !== expected) {
    return respond.fail(
      ErrorCode.INTERNAL_AUTH_INVALID,
      getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID, "내부 이벤트 인증에 실패했습니다."),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
      correlationId,
    );
  }

  return null;
}
