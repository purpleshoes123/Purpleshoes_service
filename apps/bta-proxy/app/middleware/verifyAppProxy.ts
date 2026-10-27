import { createHmac, timingSafeEqual } from "crypto";
import { json } from "~/lib/httpJson";
import { ErrorCode, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";

function normalizeHexSignature(sig: string, expectedLen: number) {
  const s = (sig ?? "").trim().toLowerCase();

  // hex가 아니면 즉시 실패
  if (!/^[0-9a-f]+$/.test(s)) return null;

  // Shopify가 드물게 leading 0을 생략한 형태(63 등)로 올 수 있으니 padStart
  return s.padStart(expectedLen, "0");
}

/**
 * SSOT 4장: App Proxy 서명 검증
 * 모든 /proxy/bta/* 요청은 이 검증을 통과해야 합니다.
 */

/**
 * App Proxy 서명을 검증합니다.
 * SSOT 4.2: 쿼리 파라미터의 signature 제외 후 정렬/결합, HMAC-SHA256 생성, 상수시간 비교
 * @returns Response를 반환하면 검증 실패, void를 반환하면 검증 성공
 */
export async function verifyAppProxy(
  request: Request,
): Promise<ReturnType<typeof json> | void> {
  // SHOPIFY_API_SECRET을 우선 사용, 없으면 SHOPIFY_APP_SECRET 사용 (하위 호환성)
  const appSecret =
    process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_APP_SECRET;

  if (!appSecret) {
    const correlationId = respond.getCorrelationId(request);
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      "SHOPIFY_API_SECRET (또는 SHOPIFY_APP_SECRET) 환경변수가 설정되지 않았습니다.",
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }

  const url = new URL(request.url);
  const params = url.searchParams;
  const providedRaw = params.get("signature");

  if (!providedRaw) {
    const correlationId = respond.getCorrelationId(request);
    return respond.fail(
      ErrorCode.AUTH_PROXY_SIGNATURE_INVALID,
      "서명이 없습니다.",
      undefined,
      401,
      correlationId,
    );
  }

  // SSOT 4.2: signature를 제외한 쿼리 파라미터 정렬 및 결합
  // 1) signature 제외하고 key=value(배열은 콤마) 문자열로 구성 (값은 디코딩된 값 사용)
  const keys = Array.from(new Set(Array.from(params.keys()))).filter(
    (k) => k !== "signature",
  );

  const parts = keys.map((k) => {
    const values = params.getAll(k); // 중복 키 → 배열
    return `${k}=${values.join(",")}`;
  });

  // 2) 정렬 후 구분자 없이 결합 (중요: "&" 쓰면 안 됨)
  parts.sort();
  const message = parts.join("");

  // 3) HMAC-SHA256 hex digest
  const computed = createHmac("sha256", appSecret)
    .update(message, "utf8")
    .digest("hex");

  // 4) 비교(상수시간). 길이 차이를 대비해 normalize
  const provided = normalizeHexSignature(providedRaw, computed.length);

  const ok =
    provided?.length === computed.length &&
    timingSafeEqual(
      Buffer.from(provided, "hex"),
      Buffer.from(computed, "hex"),
    );

  // 상수시간 비교
  if (!ok) {
    const correlationId = respond.getCorrelationId(request);
    return respond.fail(
      ErrorCode.AUTH_PROXY_SIGNATURE_INVALID,
      "서명 검증에 실패했습니다. SHOPIFY_API_SECRET이 Shopify 앱의 Client Secret과 일치하는지 확인하세요.",
      undefined,
      401,
      correlationId,
    );
  }
}
