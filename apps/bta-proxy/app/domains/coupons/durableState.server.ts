import db from "~/db.server.ts";

// RDS is authoritative on the new fleet. Never fall back to Redis/memory on a
// database error: doing so could reissue coupons or resend registration mail.
export function usesDurableCouponState(): boolean {
  return process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
}

function stringFields(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new Error("Invalid durable coupon state");
  }
  return { ...value } as Record<string, string>;
}

async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // Database driver errors can contain query parameters (customer/coupon data).
    throw new Error("Durable coupon storage unavailable");
  }
}

export function readDurableCouponState(key: string): Promise<Record<string, string>> {
  return safely(async () => {
    const rows = await db.$queryRaw<Array<{ fields: unknown }>>`
      SELECT fields FROM durable_coupon_state WHERE state_key = ${key}`;
    return rows.length ? stringFields(rows[0].fields) : {};
  });
}

export function patchDurableCouponState(
  key: string,
  fields: Record<string, string>,
): Promise<void> {
  return safely(async () => {
    const serialized = JSON.stringify(stringFields(fields));
    // Merge inside the database, not read/modify/write in a server process.
    await db.$executeRaw`
      INSERT INTO durable_coupon_state (state_key, fields, updated_at)
      VALUES (${key}, ${serialized}::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (state_key) DO UPDATE
      SET fields = durable_coupon_state.fields || EXCLUDED.fields,
          updated_at = CURRENT_TIMESTAMP`;
  });
}

export function clearDurableCouponFields(key: string, fields: string[]): Promise<void> {
  return safely(async () => {
    if (!fields.every((field) => typeof field === "string")) {
      throw new Error();
    }
    if (!fields.length) {
      return;
    }
    await db.$executeRaw`
      UPDATE durable_coupon_state
      SET fields = fields - ${fields}::text[], updated_at = CURRENT_TIMESTAMP
      WHERE state_key = ${key}`;
  });
}

export function markDurableRevoked(scope: string, code: string): Promise<void> {
  return safely(async () => {
    // Both memberships commit in one statement, unlike two independent SADDs.
    await db.$executeRaw`
      INSERT INTO durable_coupon_revocations (scope, code)
      VALUES (${scope}, ${code}), ('coupon:revoked:code', ${code})
      ON CONFLICT (scope, code) DO NOTHING`;
  });
}

export function unmarkDurableRevoked(scope: string, code: string): Promise<void> {
  return safely(async () => {
    await db.$executeRaw`
      DELETE FROM durable_coupon_revocations
      WHERE code = ${code} AND scope IN (${scope}, 'coupon:revoked:code')`;
  });
}

export function isDurableRevoked(scope: string, code: string): Promise<boolean> {
  return safely(async () => {
    const rows = await db.$queryRaw<Array<{ found: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM durable_coupon_revocations
        WHERE code = ${code} AND scope IN (${scope}, 'coupon:revoked:code')) AS found`;
    return rows[0]?.found === true;
  });
}

export function listDurableRevoked(scope: string): Promise<Set<string>> {
  return safely(async () => {
    const rows = await db.$queryRaw<Array<{ code: string }>>`
      SELECT code FROM durable_coupon_revocations WHERE scope = ${scope}`;
    return new Set(rows.map((row) => row.code));
  });
}

export async function assertCouponMigrationVerified(): Promise<void> {
  await safely(async () => {
    const rows = await db.$queryRaw<Array<{ verified: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM fleet_state_migrations
        WHERE id = 'coupon-v1' AND verified_at IS NOT NULL) AS verified`;
    if (rows[0]?.verified !== true) {
      throw new Error();
    }
  });
}
