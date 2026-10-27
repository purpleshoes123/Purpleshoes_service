import { json } from "~/lib/httpJson";
import { randomUUID } from "crypto";

/**
 * SSOT 6장: 공통 응답 Envelope
 * 모든 응답은 이 형식을 따라야 합니다.
 */

export interface SuccessResponse<T = unknown> {
  ok: true;
  data: T;
  error: null;
  meta: {
    correlationId: string;
    rebuildRunId?: string;
  };
}

export interface ErrorResponse {
  ok: false;
  data: null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: {
    correlationId: string;
  };
}

/**
 * correlationId를 추출하거나 생성합니다.
 * SSOT 3장: X-Request-Id 헤더가 있으면 사용, 없으면 서버가 생성
 * X-Correlation-Id가 없으면 새로 생성
 */
export function getCorrelationId(request: Request): string {
  const requestId = request.headers.get("X-Request-Id");
  if (requestId) {
    return requestId;
  }
  // X-Request-Id가 없으면 새로 생성
  return randomUUID();
}

/**
 * 성공 응답을 생성합니다.
 * SSOT 6.1: 성공 응답 형식
 * @param data - 응답 데이터
 * @param meta - 메타 정보 (correlationId 포함)
 */
export function ok<T>(
  data: T,
  meta: { correlationId: string; rebuildRunId?: string },
): Response {
  const response: SuccessResponse<T> = {
    ok: true,
    data,
    error: null,
    meta,
  };

  return json(response, {
    status: 200,
    headers: {
      "X-Correlation-Id": meta.correlationId,
    },
  });
}

export function withNoStore(response: Response): Response {
  response.headers.set(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, private",
  );
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  return response;
}

/**
 * 실패 응답을 생성합니다.
 * SSOT 6.2: 실패 응답 형식
 * @param code - 에러 코드
 * @param message - 에러 메시지
 * @param details - 추가 상세 정보 (선택)
 * @param status - HTTP 상태 코드
 * @param correlationId - 상관관계 ID (선택, 없으면 자동 생성)
 */
export function fail(
  code: string,
  message: string,
  details: Record<string, unknown> | undefined,
  status: number,
  correlationId?: string,
): Response {
  const corrId = correlationId || randomUUID();

  const response: ErrorResponse = {
    ok: false,
    data: null,
    error: {
      code,
      message,
      ...(details && { details }),
    },
    meta: {
      correlationId: corrId,
    },
  };

  return json(response, {
    status,
    headers: {
      "X-Correlation-Id": corrId,
    },
  });
}

/**
 * 편의를 위한 respond 객체
 */
export const respond = {
  ok,
  fail,
  getCorrelationId,
  withNoStore,
};
