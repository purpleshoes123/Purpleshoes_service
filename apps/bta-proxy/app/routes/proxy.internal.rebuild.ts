import type { ActionFunctionArgs } from "react-router";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { rebuildSchema } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { getEnv } from "~/lib/env";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { RebuildService } from "~/domains/bookings/rebuildService";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { maskPII } from "~/lib/masking";
import { randomUUID } from "crypto";
import { logEvent } from "~/lib/logEvent";
import { setLastRebuildRun } from "~/domains/bookings/rebuildMetaStore";
import { authenticate } from "~/shopify.server";

/**
 * SSOT 16.1: POST /proxy/internal/rebuild
 * SSOT 16.2: 내부 인증 (X-Internal-Token)
 * SSOT 16.3: Rebuild 입력 스키마
 * SSOT 16.5: Rebuild 응답 스키마
 * Phase 5-6R: Redis confirmed ledger 재생성
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const rebuildRunId = randomUUID();
  const startedAt = new Date().toISOString();
  const env = getEnv();
  const authRequest = request.clone();
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // 1. 내부 인증 검증 (내부 토큰 또는 Admin 세션)
  const token = request.headers.get("X-Internal-Token");
  let adminShop: string | null = null;
  let adminContext: any = null;
  if (token) {
    const authResponse = await verifyInternal(request);
    if (authResponse) {
      return authResponse;
    }
  } else {
    try {
      const auth = await authenticate.admin(authRequest);
      adminShop = auth.session.shop;
      adminContext = auth.admin;
    } catch (error) {
      if (error instanceof Response) {
        return respond.fail(
          ErrorCode.INTERNAL_AUTH_INVALID,
          getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID),
          undefined,
          getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
          respond.getCorrelationId(request),
        );
      }
      throw error;
    }
  }

  // 2. shop allowlist 검증 (설정된 경우)
  let shop: string | null = null;
  try {
    const validatedInput = rebuildSchema.parse(body);
    shop = validatedInput.shop || null;

    if (env.REBUILD_ALLOWED_SHOPS) {
      const allowedShops = env.REBUILD_ALLOWED_SHOPS.split(",").map((s) => s.trim());
      if (shop && !allowedShops.includes(shop)) {
        return respond.fail(
          ErrorCode.INTERNAL_AUTH_INVALID,
          getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID, "허용되지 않은 shop입니다."),
          undefined,
          getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
          correlationId,
        );
      }
    }

    // 3. shop 결정 (없으면 기본 shop 사용 - 구현에서는 필수로 처리)
    if (!shop) {
      // shop이 없으면 URL에서 추출 시도
      const url = new URL(request.url);
      shop = url.searchParams.get("shop");
    }
    if (!shop && adminShop) {
      shop = adminShop;
    }

    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    // shop 도메인 정규화
    if (!shop.includes(".")) {
      shop = `${shop}.myshopify.com`;
    }

    // 4. Redis 클라이언트 가져오기
    const bookingStore = getBookingStore();
    const redisClient =
      typeof (bookingStore as any).getRedisClient === "function"
        ? (bookingStore as any).getRedisClient()
        : (bookingStore as any).client;
    if (!redisClient) {
      console.warn(
        JSON.stringify(
          maskPII({
            correlationId,
            message: "Rebuild skipped (Redis store required)",
            storeType: bookingStore.constructor.name,
          }),
        ),
      );
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(
          ErrorCode.INTERNAL_ERROR,
          "Rebuild는 Redis Store에서만 사용할 수 있습니다.",
        ),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId,
      );
    }

    // 5. Rebuild 서비스 생성
    const rebuildService = new RebuildService(redisClient);

    // 6. 락 획득
    const lockAcquired = await rebuildService.acquireLock(shop);
    if (!lockAcquired) {
      return respond.fail(
        ErrorCode.REBUILD_IN_PROGRESS,
        getErrorMessage(ErrorCode.REBUILD_IN_PROGRESS),
        undefined,
        getErrorStatus(ErrorCode.REBUILD_IN_PROGRESS),
        correlationId,
      );
    }

    try {
      logEvent(
        "rebuild.start",
        {
          rebuildRunId,
          shop,
          ordersFrom: validatedInput.ordersFrom,
          ordersTo: validatedInput.ordersTo,
        },
        { correlationId, shop, severity: "info" },
      );
      // 7. Shopify Admin API 클라이언트 가져오기
      const admin = adminContext || (await getAdminApiClient(shop));
      if (!admin) {
        return respond.fail(
          ErrorCode.SHOPIFY_ADMIN_API_ERROR,
          getErrorMessage(
            ErrorCode.SHOPIFY_ADMIN_API_ERROR,
            "Shopify Admin API 세션을 찾을 수 없습니다.",
          ),
          undefined,
          getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
          correlationId,
        );
      }

      // 8. 주문 조회
      let orders;
      try {
        orders = await rebuildService.fetchOrders(
          admin,
          validatedInput.ordersFrom,
          validatedInput.ordersTo,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("SHOPIFY_ADMIN_API_TIMEOUT")) {
          return respond.fail(
            ErrorCode.SHOPIFY_ADMIN_API_TIMEOUT,
            getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_TIMEOUT),
            undefined,
            getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_TIMEOUT),
            correlationId,
          );
        }
        return respond.fail(
          ErrorCode.SHOPIFY_ADMIN_API_ERROR,
          getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
          undefined,
          getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
          correlationId,
        );
      }

      await rebuildService.removeCancelledBookings(shop, orders, validatedInput.dryRun);

      // 9. travel_date가 있는 line_items 추출
      const travelLineItems = rebuildService.extractTravelLineItems(orders);

      // 10. groupKey로 그룹화
      const groups = await rebuildService.groupLineItemsByBooking(travelLineItems, shop);

      // 관측된 travel_date 목록 수집 (replace 모드에서 사용)
      const observedTravelDates = Array.from(new Set(groups.map((g) => g.bookingInfo.travelDate)));

      // 11. (mode=replace) 기존 원장 삭제
      let deletedBookings = 0;
      if (validatedInput.mode === "replace") {
        deletedBookings = await rebuildService.deleteExistingBookings(
          shop,
          observedTravelDates,
          validatedInput.filterTravelFrom,
          validatedInput.filterTravelTo,
          validatedInput.dryRun,
        );
      }

      // 12. confirmed upsert
      const upsertedBookings = await rebuildService.upsertBookings(
        shop,
        groups,
        validatedInput.filterTravelFrom,
        validatedInput.filterTravelTo,
        validatedInput.dryRun,
      );

      // 13. 위반 탐지
      const violations = await rebuildService.detectViolations(shop);

      // 14. 결과 반환
      const result = {
        scannedOrders: orders.length,
        scannedLineItems: orders.reduce((sum, order) => sum + order.lineItems.edges.length, 0),
        matchedTravelLineItems: travelLineItems.length,
        upsertedBookings,
        deletedBookings,
        violations,
      };
      const finishedAt = new Date().toISOString();
      try {
        await setLastRebuildRun(redisClient, shop, {
          runId: rebuildRunId,
          startedAt,
          finishedAt,
          mode: validatedInput.mode,
          ordersFrom: validatedInput.ordersFrom,
          ordersTo: validatedInput.ordersTo,
          result: {
            scannedOrders: result.scannedOrders,
            scannedLineItems: result.scannedLineItems,
            matchedTravelLineItems: result.matchedTravelLineItems,
            upsertedBookings: result.upsertedBookings,
            deletedBookings: result.deletedBookings,
          },
        });
      } catch {
        // rebuild 결과 저장 실패는 요청 실패로 처리하지 않음
      }

      logEvent(
        "rebuild.completed",
        {
          rebuildRunId,
          scannedOrders: result.scannedOrders,
          matchedTravelLineItems: result.matchedTravelLineItems,
          upsertedBookings,
          deletedBookings,
        },
        { correlationId, shop, severity: "info" },
      );

      return respond.ok(result, { correlationId, rebuildRunId });
    } catch (error) {
      console.error(
        JSON.stringify(
          maskPII({
            correlationId,
            message: "Rebuild 처리 중 오류",
            error: error instanceof Error ? error.message : String(error),
            shop: shop.substring(0, 20) + "...",
          }),
        ),
      );
      logEvent(
        "rebuild.failed",
        {
          rebuildRunId,
          error: error instanceof Error ? error.message : String(error),
        },
        { correlationId, shop, severity: "error" },
      );

      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(ErrorCode.INTERNAL_ERROR),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId,
      );
    } finally {
      // 15. 락 해제
      await rebuildService.releaseLock(shop);
    }
  } catch (error) {
    // JSON 파싱 또는 검증 에러
    if (error instanceof SyntaxError) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

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

    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Rebuild 엔드포인트 오류",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
