import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { globalBlackoutToggleSchema } from "~/lib/validation";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  createGlobalBlackout,
  deleteGlobalBlackout,
  listGlobalBlackoutRecordsByDate,
  getAdminApiClient,
} from "~/lib/shopifyAdmin";
import { getBookingStore } from "~/domains/bookings/bookingStore";
import { randomUUID } from "crypto";

const LOCK_TTL_MS = 3000;
const inMemoryLocks = new Map<string, { expiresAt: number; token: string }>();

async function resolveAdminClient(shop: string) {
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }
  return admin;
}

async function acquireLock(shop: string, date: string) {
  const lockKey = `lock:global_blackout:${shop}:${date}`;
  const bookingStore = getBookingStore();
  if (bookingStore.constructor.name === "RedisBookingStore") {
    const client = (bookingStore as any).client;
    const token = randomUUID();
    const result = await client.set(lockKey, token, "PX", LOCK_TTL_MS, "NX");
    if (!result) {
      return null;
    }
    return {
      release: async () => {
        const current = await client.get(lockKey);
        if (current === token) {
          await client.del(lockKey);
        }
      },
    };
  }

  const now = Date.now();
  const existing = inMemoryLocks.get(lockKey);
  if (existing && existing.expiresAt > now) {
    return null;
  }
  const token = randomUUID();
  inMemoryLocks.set(lockKey, { expiresAt: now + LOCK_TTL_MS, token });
  return {
    release: async () => {
      const current = inMemoryLocks.get(lockKey);
      if (current?.token === token) {
        inMemoryLocks.delete(lockKey);
      }
    },
  };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  try {
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const validatedInput = globalBlackoutToggleSchema.parse(body);
    const token = request.headers.get("X-Internal-Token");
    let shop: string | null = null;
    let admin: Awaited<ReturnType<typeof resolveAdminClient>> | null = null;

    if (token) {
      const authResponse = await verifyInternal(request);
      if (authResponse) {
        return authResponse;
      }

      shop = validatedInput.shop || null;
      if (!shop) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop은 필수입니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }

      if (!shop.includes(".")) {
        shop = `${shop}.myshopify.com`;
      }

      admin = await resolveAdminClient(shop);
    } else {
      try {
        const auth = await authenticate.admin(request);
        shop = auth.session.shop;
        admin = auth.admin;
      } catch (error) {
        if (error instanceof Response) {
          return respond.fail(
            ErrorCode.INTERNAL_AUTH_INVALID,
            getErrorMessage(ErrorCode.INTERNAL_AUTH_INVALID),
            undefined,
            getErrorStatus(ErrorCode.INTERNAL_AUTH_INVALID),
            correlationId,
          );
        }
        throw error;
      }
    }

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

    const lock = await acquireLock(shop, validatedInput.date);
    if (!lock) {
      return respond.fail(
        ErrorCode.INTERNAL_CONFLICT,
        getErrorMessage(ErrorCode.INTERNAL_CONFLICT),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_CONFLICT),
        correlationId,
      );
    }

    try {
      const existingRecords = await listGlobalBlackoutRecordsByDate({
        admin,
        shop,
        date: validatedInput.date,
      });

      if (existingRecords.length > 0) {
        await Promise.all(
          existingRecords.map((record) => deleteGlobalBlackout({ admin, shop, id: record.id })),
        );
        return respond.ok(
          {
            action: "deleted",
            date: validatedInput.date,
          },
          { correlationId },
        );
      }

      const created = await createGlobalBlackout({
        admin,
        shop,
        date: validatedInput.date,
        note: validatedInput.note,
      });

      const afterCreate = await listGlobalBlackoutRecordsByDate({
        admin,
        shop,
        date: validatedInput.date,
      });
      const duplicates = afterCreate.filter((item) => item.id !== created.id);
      if (duplicates.length > 0) {
        await Promise.all(
          duplicates.map((record) => deleteGlobalBlackout({ admin, shop, id: record.id })),
        );
      }

      return respond.ok(
        {
          action: "created",
          date: validatedInput.date,
          item: created,
        },
        { correlationId },
      );
    } finally {
      await lock.release();
    }
  } catch (error) {
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

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
