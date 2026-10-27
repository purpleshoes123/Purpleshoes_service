
import { ErrorCode } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { maskPII } from "~/lib/masking";
import { createHash } from "node:crypto";
import { getRateLimitClientIp } from "~/lib/rateLimit/clientIp.server";
import { getRedisRateLimitCounterStore } from "~/lib/rateLimit/rateLimitStore.server";

/**
 * SSOT 9장: 레이트 리밋
 * IP 기준 60 req/min (기본값, 환경변수로 조정 가능)
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// 메모리 기반 레이트 리밋 저장소
// 프로덕션에서는 Redis 등을 사용하는 것이 좋습니다.
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * 클라이언트 IP 주소를 추출합니다.
 */
function getClientIp(request: Request): string {
  return getRateLimitClientIp(request);
}

function limitPerMinute(): number {
  const value = Number(process.env.RATE_LIMIT_PER_MIN);
  return Number.isSafeInteger(value) && value > 0 ? value : 60;
}

/**
 * 레이트 리밋을 확인하고 업데이트합니다.
 * @returns true if rate limit exceeded, false otherwise
 */
export async function checkRateLimit(request: Request): Promise<boolean> {
  const ip = getClientIp(request);
  const limitPerMin = limitPerMinute();
  const windowMs = 60 * 1000; // 1분

  if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
    const shared = getRedisRateLimitCounterStore();
    if (!shared) throw new Error("Shared rate limiter unavailable");
    const fingerprint = createHash("sha256").update(ip).digest("hex");
    const result = await shared.increment(`bta:rate-limit:ip:v1:${fingerprint}`, windowMs);
    return result.count > limitPerMin;
  }

  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  // 엔트리가 없거나 윈도우가 만료된 경우 새로 생성
  if (!entry || entry.resetAt < now) {
    rateLimitStore.set(ip, {
      count: 1,
      resetAt: now + windowMs,
    });
    return false;
  }

  // 카운트 증가
  entry.count++;

  // 한도 초과 확인
  if (entry.count > limitPerMin) {
    return true;
  }

  return false;
}

/**
 * 레이트 리밋을 검증하고 초과 시 Response를 반환합니다.
 * @returns Response를 반환하면 레이트 리밋 초과, void를 반환하면 정상
 */
export async function enforceRateLimit(request: Request): Promise<Response | void> {
  let exceeded: boolean;
  try {
    exceeded = await checkRateLimit(request);
  } catch {
    const response = respond.fail(ErrorCode.INTERNAL_ERROR,
      "Service temporarily unavailable. Please try again shortly.",
      undefined, 503, respond.getCorrelationId(request));
    response.headers.set("Retry-After", "5");
    return respond.withNoStore(response);
  }
  if (exceeded) {
    const correlationId = respond.getCorrelationId(request);
    const ip = getClientIp(request);
    const limitPerMin = limitPerMinute();

    // 로깅 (PII 마스킹)
    console.warn(
      JSON.stringify({
        correlationId,
        message: "Rate limit exceeded",
        ip: maskPII(ip),
        limitPerMin,
        path: new URL(request.url).pathname,
      })
    );

    const response = respond.fail(
      ErrorCode.RATE_LIMITED,
      "요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.",
      undefined,
      429,
      correlationId
    );
    response.headers.set("Retry-After", "60");
    return respond.withNoStore(response);
  }
}

/**
 * 주기적으로 만료된 엔트리를 정리합니다.
 * (메모리 누수 방지)
 */
export function cleanupRateLimitStore() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(ip);
    }
  }
}

// 5분마다 정리 작업 실행
if (typeof setInterval !== "undefined") {
  setInterval(cleanupRateLimitStore, 5 * 60 * 1000).unref?.();
}
