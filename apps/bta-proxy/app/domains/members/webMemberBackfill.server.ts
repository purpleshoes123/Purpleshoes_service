import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "~/db.server.ts";
import { getState } from "../coupons/state";
import { hasVerifiedWebRegistration, syncVerifiedWebMemberTag } from "./webMemberTag.server.ts";

// Operator-only, read-only by default. No HTTP route, coupon issuance, mail,
// consent changes, or inference that customers without proof are nonmembers.
export async function backfillVerifiedWebMembers(admin: AdminApiContext, apply = false) {
  const rows = await db.$queryRaw<Array<{ state_key: string }>>`
    SELECT state_key FROM durable_coupon_state ORDER BY state_key LIMIT 1001`;
  if (rows.length > 1000) {
    throw new Error("Review a larger backfill before running");
  }
  const result = {
    mode: apply ? "apply" : "dry-run",
    scanned: rows.length,
    verified: 0,
    alreadySynced: 0,
    pending: 0,
    updated: 0,
    failed: 0,
  };
  for (const row of rows) {
    const customerId = /^coupon:state:customer:([1-9]\d*)$/.exec(row.state_key)?.[1];
    if (!customerId) {
      continue;
    }
    const state = await getState(customerId);
    if (!hasVerifiedWebRegistration(state)) {
      continue;
    }
    result.verified++;
    if (state.webMemberTagSynced) {
      result.alreadySynced++;
      continue;
    }
    result.pending++;
    if (!apply) {
      continue;
    }
    try {
      await syncVerifiedWebMemberTag(admin, customerId, state);
      result.updated++;
    } catch {
      result.failed++;
    }
  }
  return result;
}
