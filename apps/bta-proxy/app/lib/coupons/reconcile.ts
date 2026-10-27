import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getState, clearStateFields } from "./state";
import { markRevoked } from "./revoked";
import { fetchDiscountStatusById, fetchDiscountStatusByCode } from "./shopifyDiscounts";
import type { DiscountStatusResult } from "./types";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 250
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const delay = baseDelayMs * Math.pow(2, i);
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Retry failed");
}

export type ReconcileReport = {
  checkedCodes: string[];
  invalidDetected: Array<{ code: string; status: string; reason?: string }>;
  clearedFields: string[];
  revokedCodes: string[];
  warnings: string[];
};

type CodeRecord = {
  code: string;
  kind: "guide50" | "extra10";
  discountId?: string | null;
  expiresAt?: number | null;
  clearFields: string[];
};

export async function reconcileCustomerCoupons(
  admin: AdminApiContext,
  customerId: string,
  dryRun = true
): Promise<ReconcileReport> {
  const state = await getState(customerId);
  const nowSec = Math.floor(Date.now() / 1000);

  const records: CodeRecord[] = [];
  if (state.guide50Code) {
    records.push({
      code: state.guide50Code,
      kind: "guide50",
      discountId: state.guide50DiscountId,
      expiresAt: state.guide50ExpiresAt,
      clearFields: [
        "guide50Code",
        "guide50IssuedAt",
        "guide50ExpiresAt",
        "guide50DiscountId",
      ],
    });
  }
  if (state.extra10Code) {
    records.push({
      code: state.extra10Code,
      kind: "extra10",
      discountId: state.extra10DiscountId,
      clearFields: ["extra10Code", "extra10IssuedAt", "extra10DiscountId"],
    });
  }

  const report: ReconcileReport = {
    checkedCodes: records.map((record) => record.code),
    invalidDetected: [],
    clearedFields: [],
    revokedCodes: [],
    warnings: [],
  };

  for (const record of records) {
    let statusResult: DiscountStatusResult | null = null;

    if (record.expiresAt && nowSec > record.expiresAt) {
      statusResult = { status: "invalid", reason: "expired" };
    }

    if (!statusResult) {
      try {
        statusResult = await withRetry(async () => {
          if (record.discountId) {
            return await fetchDiscountStatusById(admin, record.discountId);
          }
          return await fetchDiscountStatusByCode(admin, record.code);
        });
      } catch (error) {
        report.warnings.push(
          `Failed to validate code ${record.code}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        statusResult = { status: "unknown", reason: "lookup_failed" };
      }
    }

    if (statusResult.status === "invalid") {
      report.invalidDetected.push({
        code: record.code,
        status: statusResult.status,
        reason: statusResult.reason,
      });
      if (!dryRun) {
        await markRevoked(customerId, record.code);
        await clearStateFields(customerId, record.clearFields);
      }
      report.revokedCodes.push(record.code);
      report.clearedFields.push(...record.clearFields);
    } else if (statusResult.status === "unknown") {
      report.warnings.push(
        `Code ${record.code} validation unknown: ${statusResult.reason || "unknown"}`
      );
    }
  }

  report.clearedFields = Array.from(new Set(report.clearedFields));
  report.revokedCodes = Array.from(new Set(report.revokedCodes));

  return report;
}
