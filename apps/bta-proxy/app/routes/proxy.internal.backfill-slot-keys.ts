import type { ActionFunctionArgs } from "react-router";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { backfillSlotKeysSchema } from "~/lib/validation";
import { ErrorCode, getErrorStatus, getErrorMessage } from "~/lib/errors";
import { getEnv } from "~/lib/env";
import { getBookingStore } from "~/lib/bookingStore";
import { makeSlotKey } from "~/lib/bookingKeys";
import { maskPII } from "~/lib/masking";
import { RebuildStoreKeys } from "~/lib/rebuildStore";

async function scanKeys(redisClient: any, pattern: string): Promise<string[]> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const result = await redisClient.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = result[0];
    const batch = result[1] as string[];
    if (batch.length > 0) {
      keys.push(...batch);
    }
  } while (cursor !== "0");
  return keys;
}

/**
 * POST /proxy/internal/backfill-slot-keys
 * Internal: restore legacy confirmed:{slotKey} from confirmed ledger
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const authResponse = await verifyInternal(request);
  if (authResponse) return authResponse;

  const correlationId = respond.getCorrelationId(request);
  const env = getEnv();

  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const validatedInput = backfillSlotKeysSchema.parse(body);
    if (!validatedInput.dryRun && process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      return new Response("Legacy backfill is unavailable on the durable fleet; use verified journal recovery", { status: 409 });
    }
    let shop = validatedInput.shop || null;

    if (!shop) {
      const url = new URL(request.url);
      shop = url.searchParams.get("shop");
    }

    if (!shop) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    if (!shop.includes(".")) {
      shop = `${shop}.myshopify.com`;
    }

    if (env.REBUILD_ALLOWED_SHOPS) {
      const allowedShops = env.REBUILD_ALLOWED_SHOPS.split(",").map((s) => s.trim());
      if (!allowedShops.includes(shop)) {
        return respond.fail(
          ErrorCode.INTERNAL_AUTH_INVALID,
          getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID, "허용되지 않은 shop입니다."),
          undefined,
          getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
          correlationId
        );
      }
    }

    const bookingStore = getBookingStore();
    if (bookingStore.constructor.name !== "RedisBookingStore") {
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(
          ErrorCode.INTERNAL_ERROR,
          "Backfill은 Redis Store에서만 사용할 수 있습니다."
        ),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId
      );
    }

    const redisClient = (bookingStore as any).client;

    const ledgerKeys = await scanKeys(
      redisClient,
      `booking:confirmed:${shop}:*`
    );

    const slotKeys = new Set<string>();
    let matchedRecords = 0;

    for (const key of ledgerKeys) {
      const raw = await redisClient.get(key);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw) as {
          bookingId?: string;
          productId?: string;
          travelDate?: string;
          bookingMode?: string;
          poolKey?: string;
          guideUnitsRequired?: number;
          orderId?: string;
          groupKey?: string;
        };
        if (!record.bookingId || !record.productId || !record.travelDate) {
          continue;
        }
        matchedRecords += 1;
        const slotKey = makeSlotKey(record.productId, record.travelDate);
        slotKeys.add(slotKey);

        if (validatedInput.dryRun) {
          continue;
        }

        await redisClient.sadd(
          RebuildStoreKeys.dateIndex(shop, record.travelDate),
          record.bookingId
        );
        await redisClient.sadd(
          RebuildStoreKeys.slotIndex(shop, slotKey),
          record.bookingId
        );
        if (record.poolKey) {
          await redisClient.sadd(
            RebuildStoreKeys.poolIndex(
              shop,
              `${record.poolKey}|${record.travelDate}`
            ),
            record.bookingId
          );
        }
        if (record.orderId) {
          await redisClient.sadd(
            RebuildStoreKeys.orderIndex(shop, record.orderId),
            record.bookingId
          );
        }
        if (record.groupKey) {
          await redisClient.set(
            RebuildStoreKeys.groupIndex(shop, record.groupKey),
            record.bookingId
          );
        }
        if (record.orderId && record.groupKey) {
          await redisClient.set(
            `confirmed:${shop}|${record.orderId}|${record.groupKey}`,
            JSON.stringify({
              shop,
              orderId: record.orderId,
              lineItemId: record.groupKey,
              slotKey,
              productId: record.productId,
              date: record.travelDate,
              bookingMode: record.bookingMode,
              poolKey: record.poolKey,
              guideUnitsRequired: record.guideUnitsRequired,
              groupKey: record.groupKey,
            })
          );
        }
      } catch {
        continue;
      }
    }

    if (!validatedInput.dryRun) {
      for (const slotKey of slotKeys) {
        await redisClient.set(`confirmed:${slotKey}`, "1");
      }
    }

    return respond.ok(
      {
        scannedRecords: ledgerKeys.length,
        matchedRecords,
        updatedSlotKeys: slotKeys.size,
        dryRun: validatedInput.dryRun,
      },
      { correlationId }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "잘못된 JSON 형식입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      const errorMessage = zodError.issues
        .map((issue) => issue.message)
        .join(", ");
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, errorMessage),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Backfill slot keys error",
          error: error instanceof Error ? error.message : String(error),
        })
      )
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
