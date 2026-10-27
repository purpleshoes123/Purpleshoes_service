/**
 * Shopify Webhook HMAC 검증
 * Phase 5-4: X-Shopify-Hmac-Sha256 헤더 기반 raw body 검증
 * 
 * SSOT 15.2: Webhook은 raw body를 그대로 사용하여 HMAC-SHA256 계산
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Shopify Webhook HMAC을 검증합니다.
 * @param request Webhook 요청
 * @returns { verified: true, rawBody: string } 또는 { verified: false, response: Response }
 */
export async function verifyWebhook(
  request: Request
): Promise<
  | { verified: true; rawBody: string }
  | { verified: false; response: Response }
> {
  const appSecret =
    process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_APP_SECRET;

  if (!appSecret) {
    return {
      verified: false,
      response: new Response("SHOPIFY_API_SECRET not configured", {
        status: 500,
      }),
    };
  }

  // X-Shopify-Hmac-Sha256 헤더 확인
  const providedHmac = request.headers.get("X-Shopify-Hmac-Sha256");

  if (!providedHmac) {
    return {
      verified: false,
      response: new Response("Missing X-Shopify-Hmac-Sha256 header", {
        status: 401,
      }),
    };
  }

  // Raw body를 그대로 사용 (JSON 파싱 전)
  // Remix에서는 request.clone()으로 body를 읽어야 함
  const clonedRequest = request.clone();
  const rawBody = await clonedRequest.text();

  // HMAC-SHA256 계산
  const computedHmac = createHmac("sha256", appSecret)
    .update(rawBody, "utf8")
    .digest("base64");

  // Base64 비교 (상수시간)
  const providedBuffer = Buffer.from(providedHmac, "base64");
  const computedBuffer = Buffer.from(computedHmac, "base64");

  if (
    providedBuffer.length !== computedBuffer.length ||
    !timingSafeEqual(providedBuffer, computedBuffer)
  ) {
    return {
      verified: false,
      response: new Response("HMAC verification failed", { status: 401 }),
    };
  }

  // 검증 성공
  return { verified: true, rawBody };
}

