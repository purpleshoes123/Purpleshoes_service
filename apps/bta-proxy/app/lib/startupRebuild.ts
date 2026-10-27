/**
 * 부팅 시 자동 Rebuild
 * Phase X: 서버 시작 시 조건부로 confirmed ledger 자동 재구성
 */

import { randomUUID } from "crypto";
import { getEnv } from "~/lib/env";
import { getBookingStore } from "~/lib/bookingStore";
import { RebuildService } from "~/lib/rebuildService";
import { RebuildStoreKeys } from "~/lib/rebuildStore";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { maskPII } from "~/lib/masking";
import prisma from "~/db.server";

/**
 * 부팅 시 자동 Rebuild 실행
 * - 환경변수 REBUILD_AUTO_ON_STARTUP=true일 때만 실행
 * - Redis 락으로 동시 실행 방지
 * - 에러 발생 시에도 서버 부팅은 계속됨
 */
export async function startupRebuild(): Promise<void> {
  const rebuildRunId = randomUUID();
  const env = getEnv();
  const logDebug = (payload: Record<string, unknown>): void => {
    if (process.env.DEBUG_BOOKING === "1") {
      console.log(JSON.stringify(payload));
    }
  };

  console.log(
    JSON.stringify({
      rebuildRunId,
      message: "Startup rebuild debug flag",
      DEBUG_BOOKING: process.env.DEBUG_BOOKING || "(not set)",
    })
  );

  try {
    // 1. 환경변수 검사
    if (env.REBUILD_AUTO_ON_STARTUP !== "true") {
      console.log(
        JSON.stringify({
          rebuildRunId,
          message: "Startup rebuild skipped (REBUILD_AUTO_ON_STARTUP not enabled)",
        })
      );
      return;
    }

    console.log(
      JSON.stringify({
        rebuildRunId,
        message: "Startup rebuild started",
      })
    );

    // 2. Redis 클라이언트 가져오기
    const bookingStore = getBookingStore();
    const redisClient = (bookingStore as any).client;
    if (!redisClient) {
      console.warn(
        JSON.stringify({
          rebuildRunId,
          message: "Startup rebuild skipped (Redis store required)",
          storeType: bookingStore.constructor.name,
        })
      );
      return;
    }

    // 3. shop 목록 가져오기
    let shops: string[] = [];
    if (env.REBUILD_AUTO_SHOPS) {
      // 환경변수에서 shop 목록 가져오기
      shops = env.REBUILD_AUTO_SHOPS.split(",").map((s) => s.trim());
    } else {
      // Prisma 세션 스토리지에서 모든 shop 조회
      try {
        logDebug({
          rebuildRunId,
          message: "Startup rebuild fetching shops from session storage",
        });
        const sessions = await prisma.session.findMany({
          select: { shop: true },
          distinct: ["shop"],
        });
        logDebug({
          rebuildRunId,
          message: "Startup rebuild fetched shops from session storage",
          sessionCount: sessions.length,
        });
        shops = sessions
          .map((s) => s.shop)
          .filter((shop): shop is string => shop !== null);
      } catch (error) {
        console.error(
          JSON.stringify({
            rebuildRunId,
            message: "Failed to fetch shops from session storage",
            error: error instanceof Error ? error.message : String(error),
          })
        );
        return;
      }
    }

    if (shops.length === 0) {
      console.log(
        JSON.stringify({
          rebuildRunId,
          message: "Startup rebuild skipped (no shops found)",
        })
      );
      return;
    }

    logDebug({
      rebuildRunId,
      message: "Startup rebuild shops resolved",
      shopsCount: shops.length,
      shops: shops.slice(0, 10),
    });

    // 4. Rebuild 서비스 생성
    const rebuildService = new RebuildService(redisClient);

    // 5. 각 shop에 대해 rebuild 실행
    for (const shop of shops) {
      try {
        logDebug({
          rebuildRunId,
          message: "Startup rebuild begin shop",
          shop: shop.substring(0, 30),
        });
        await rebuildForShop(shop, rebuildService, redisClient, rebuildRunId, env);
      } catch (error) {
        console.error(
          JSON.stringify(
            maskPII({
              rebuildRunId,
              message: "Startup rebuild failed for shop",
              shop: shop.substring(0, 20) + "...",
              error: error instanceof Error ? error.message : String(error),
            })
          )
        );
        // 한 shop 실패해도 다른 shop은 계속 처리
        continue;
      }
    }

    console.log(
      JSON.stringify({
        rebuildRunId,
        message: "Startup rebuild completed",
        shopsProcessed: shops.length,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        rebuildRunId,
        message: "Startup rebuild failed",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    // 에러 발생해도 서버 부팅은 계속됨
  }
}

/**
 * 특정 shop에 대해 rebuild 실행
 */
async function rebuildForShop(
  shop: string,
  rebuildService: RebuildService,
  redisClient: any,
  rebuildRunId: string,
  env: ReturnType<typeof getEnv>
): Promise<void> {
  const logDebug = (payload: Record<string, unknown>): void => {
    if (process.env.DEBUG_BOOKING === "1") {
      console.log(JSON.stringify(payload));
    }
  };

  // 1. REBUILD_AUTO_IF_EMPTY=true일 때 confirmed 키 존재 여부 확인
  if (env.REBUILD_AUTO_IF_EMPTY === true) {
    const hasConfirmed = await checkConfirmedKeysExist(redisClient, shop);
    if (hasConfirmed) {
      logDebug({
        rebuildRunId,
        message: "Startup rebuild skipped (confirmed keys exist)",
        shop: shop.substring(0, 20),
      });
      console.log(
        JSON.stringify({
          rebuildRunId,
          message: "Startup rebuild skipped (confirmed keys exist)",
          shop: shop.substring(0, 20) + "...",
        })
      );
      return;
    }
  }

  // 2. 락 획득 시도
  const lockAcquired = await rebuildService.acquireLock(shop);
  if (!lockAcquired) {
    logDebug({
      rebuildRunId,
      message: "Startup rebuild skipped (rebuild already in progress)",
      shop: shop.substring(0, 20),
    });
    console.log(
      JSON.stringify({
        rebuildRunId,
        message: "Startup rebuild skipped (rebuild already in progress)",
        shop: shop.substring(0, 20) + "...",
      })
    );
    return;
  }

  try {
    // 3. Shopify Admin API 클라이언트 가져오기
    const admin = await getAdminApiClient(shop);
    if (!admin) {
      logDebug({
        rebuildRunId,
        message: "Startup rebuild no admin session",
        shop: shop.substring(0, 20),
      });
      try {
        const deleted = await prisma.session.deleteMany({ where: { shop } });
        logDebug({
          rebuildRunId,
          message: "Startup rebuild cleaned up sessions for shop",
          shop: shop.substring(0, 20),
          deletedCount: deleted.count,
        });
      } catch (error) {
        console.warn(
          JSON.stringify({
            rebuildRunId,
            message: "Startup rebuild failed to cleanup sessions",
            shop: shop.substring(0, 20) + "...",
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      console.warn(
        JSON.stringify({
          rebuildRunId,
          message: "Startup rebuild skipped (no admin session found)",
          shop: shop.substring(0, 20) + "...",
        })
      );
      return;
    }

    // 4. 주문 조회 범위 계산
    const today = new Date();
    const daysAgo = env.REBUILD_AUTO_DAYS || 30;
    const ordersToOffsetDays = env.REBUILD_AUTO_TO_OFFSET_DAYS || 1;
    const ordersFrom = new Date(today);
    ordersFrom.setDate(ordersFrom.getDate() - daysAgo);
    const ordersTo = new Date(today);
    ordersTo.setDate(ordersTo.getDate() + ordersToOffsetDays);
    const ordersFromStr = ordersFrom.toISOString().split("T")[0]; // YYYY-MM-DD
    const ordersToStr = ordersTo.toISOString().split("T")[0]; // YYYY-MM-DD

    logDebug({
      rebuildRunId,
      message: "Startup rebuild fetch orders",
      shop: shop.substring(0, 20),
      ordersFrom: ordersFromStr,
      ordersTo: ordersToStr,
      ordersToOffsetDays,
    });

    console.log(
      JSON.stringify({
        rebuildRunId,
        message: "Startup rebuild fetching orders",
        shop: shop.substring(0, 20) + "...",
        ordersFrom: ordersFromStr,
        ordersTo: ordersToStr,
      })
    );

    // 5. 주문 조회
    const orders = await rebuildService.fetchOrders(admin, ordersFromStr, ordersToStr);

    logDebug({
      rebuildRunId,
      message: "Startup rebuild orders fetched",
      shop: shop.substring(0, 20),
      ordersCount: orders.length,
    });

    const removedCancelled = await rebuildService.removeCancelledBookings(
      shop,
      orders,
      false
    );
    logDebug({
      rebuildRunId,
      message: "Startup rebuild cancelled bookings removed",
      shop: shop.substring(0, 20),
      removedCount: removedCancelled,
    });

    // 6. travel_date가 있는 line_items 추출
    const travelLineItems = rebuildService.extractTravelLineItems(orders);

    logDebug({
      rebuildRunId,
      message: "Startup rebuild travel line items extracted",
      shop: shop.substring(0, 20),
      travelLineItemsCount: travelLineItems.length,
    });

    // 7. groupKey로 그룹화
    const groups = await rebuildService.groupLineItemsByBooking(travelLineItems, shop);

    logDebug({
      rebuildRunId,
      message: "Startup rebuild groups created",
      shop: shop.substring(0, 20),
      groupsCount: groups.length,
    });

    // 8. confirmed upsert
    const mode = env.REBUILD_AUTO_MODE || "upsert";
    let deletedBookings = 0;
    if (mode === "replace") {
      const observedTravelDates = Array.from(
        new Set(groups.map((g) => g.bookingInfo.travelDate))
      );
      deletedBookings = await rebuildService.deleteExistingBookings(
        shop,
        observedTravelDates,
        undefined,
        undefined,
        false
      );
    }

    const upsertedBookings = await rebuildService.upsertBookings(
      shop,
      groups,
      undefined,
      undefined,
      false
    );

    // 9. 결과 로깅
    console.log(
      JSON.stringify({
        rebuildRunId,
        message: "Startup rebuild completed for shop",
        shop: shop.substring(0, 20) + "...",
        scannedOrders: orders.length,
        matchedTravelLineItems: travelLineItems.length,
        upsertedBookings,
        deletedBookings,
      })
    );
  } finally {
    // 10. 락 해제
    await rebuildService.releaseLock(shop);
  }
}

/**
 * confirmed 키 존재 여부 확인
 * Redis SCAN을 사용하여 booking:confirmed:{shop}:* 패턴으로 확인
 */
async function checkConfirmedKeysExist(
  redisClient: any,
  shop: string
): Promise<boolean> {
  try {
    // SCAN을 사용하여 키 존재 여부 확인
    // booking:confirmed:{shop}:* 패턴으로 스캔
    const pattern = `booking:confirmed:${shop}:*`;
    let cursor = "0";
    let hasKeys = false;

    do {
      const result = await redisClient.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        1 // 최소 1개만 찾으면 충분
      );
      // ioredis scan 결과: [nextCursor, keys]
      const [nextCursor, keys] = Array.isArray(result) ? result : [result, []];
      cursor = nextCursor;
      if (keys && Array.isArray(keys) && keys.length > 0) {
        hasKeys = true;
        break;
      }
    } while (cursor !== "0");

    return hasKeys;
  } catch (error) {
    // SCAN 실패 시 안전하게 true 반환 (rebuild 실행하지 않음)
    console.warn(
      JSON.stringify({
        message: "Failed to check confirmed keys, assuming they exist",
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return true;
  }
}
