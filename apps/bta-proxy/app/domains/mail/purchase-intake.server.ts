import { randomUUID } from "node:crypto";
import db from "~/db.server.ts";
import { getPurchaseEmailConfig, purchaseEmailCandidate } from "./purchase-policy";
import { purchaseServiceEmailCandidates } from "./purchase-service-policy.server.ts";

// Called only after orders/paid HMAC verification and BEFORE legacy event dedup.
// An outbox write failure must return 503 so a webhook retry can recover it.
export async function enqueueVerifiedPurchaseEmail(rawBody: string, shop: string, topic: string) {
  const config = getPurchaseEmailConfig();
  if (!config) {
    return;
  }
  if (topic !== "orders/paid") {
    throw new Error("Unexpected purchase email topic");
  }
  const payload = JSON.parse(rawBody);
  const base = purchaseEmailCandidate(payload, shop, config);
  const candidates = [
    ...(base ? [base] : []),
    ...(await purchaseServiceEmailCandidates(payload, shop, config.allowTestOrders)),
  ];
  // If a later upsert fails, webhook retry safely recovers it without resetting earlier rows.
  for (const candidate of candidates) {
    await db.purchaseEmailOutbox.upsert({
      where: {
        shopDomain_orderId_kind: {
          shopDomain: config.shop,
          orderId: candidate.orderId,
          kind: candidate.kind,
        },
      },
      create: { id: `purchase_${randomUUID()}`, shopDomain: config.shop, ...candidate },
      update: {}, // Repeated webhook IDs or different IDs for the same order never reset delivery.
    });
  }
}
