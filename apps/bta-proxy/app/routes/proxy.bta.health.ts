import type { LoaderFunctionArgs } from "react-router";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { respond } from "~/lib/respond";

/**
 * SSOT 2.1: GET /proxy/bta/health
 * SSOT 7.1: Health 응답 스키마
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  // 1. 레이트 리밋 검증
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  // 2. App Proxy 서명 검증
  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) {
    return verifyResponse;
  }

  // 3. correlationId 추출/생성
  const correlationId = respond.getCorrelationId(request);

  // 4. Health 응답 (SSOT 7.1)
  const data = {
    status: "ok",
    service: "booking-proxy",
    version: "0.2.0",
  };

  return respond.ok(data, { correlationId });
};
