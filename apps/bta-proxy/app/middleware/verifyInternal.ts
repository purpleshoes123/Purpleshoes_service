/**
 * 내부 엔드포인트 인증 미들웨어
 * Phase 5-6R: X-Internal-Token 헤더 검증 및 shop allowlist 검증
 */

import { respond } from "~/lib/respond";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { getEnv } from "~/lib/env";

/**
 * 내부 토큰 인증 검증
 * @param request Request 객체
 * @returns 검증 실패 시 Response, 성공 시 null
 */
export async function verifyInternal(request: Request): Promise<Response | null> {
  const correlationId = respond.getCorrelationId(request);

  // 1. X-Internal-Token 헤더 확인
  const token = request.headers.get("X-Internal-Token");
  const env = getEnv();

  if (!env.INTERNAL_TOKEN) {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR, "INTERNAL_TOKEN 환경변수가 설정되지 않았습니다."),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }

  if (!token || token !== env.INTERNAL_TOKEN) {
    return respond.fail(
      ErrorCode.INTERNAL_AUTH_INVALID,
      getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
      correlationId,
    );
  }

  // 2. Shop allowlist 검증 (설정된 경우)
  if (env.REBUILD_ALLOWED_SHOPS) {
    const allowedShops = env.REBUILD_ALLOWED_SHOPS.split(",").map((s) => s.trim());

    // shop은 요청 body에서 추출해야 하므로, 여기서는 기본 검증만 수행
    // 실제 shop 검증은 엔드포인트에서 수행
  }

  return null; // 검증 성공
}
