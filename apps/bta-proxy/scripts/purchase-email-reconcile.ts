import db from "../app/db.server";
import { reconcilePurchaseEmail } from "../app/domains/mail/purchase-reconcile.server.ts";
const option = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
async function main() {
  const id = option("id");
  const shop = process.env.PURCHASE_EMAIL_SHOP || "";
  if (!shop) {
    throw new Error("Purchase shop required");
  }
  const action = option("action");
  if (!id && !action) {
    console.info(
      JSON.stringify(
        await db.purchaseEmailOutbox.findMany({
          where: { shopDomain: shop, status: { not: "SENT" } },
          orderBy: { createdAt: "asc" },
          take: 50,
          select: { id: true, kind: true, status: true, attempts: true, lastError: true },
        }),
      ),
    );
    return;
  }
  if (!/^purchase_[a-zA-Z0-9-]+$/.test(id)) {
    throw new Error("Purchase ID required");
  }
  if (!action) {
    // Default is read-only and excludes recipient/content/credentials.
    console.info(
      JSON.stringify(
        await db.purchaseEmailOutbox.findFirst({
          where: { id, shopDomain: shop },
          select: { id: true, kind: true, status: true, attempts: true, lastError: true },
        }),
      ),
    );
    return;
  }
  if (!["retry-not-accepted", "mark-accepted", "retry-preparation"].includes(action)) {
    throw new Error("Unknown reconciliation action");
  }
  console.info(
    JSON.stringify(
      await reconcilePurchaseEmail(db, {
        id,
        shop,
        action: action as "retry-not-accepted" | "mark-accepted" | "retry-preparation",
        evidence: option("evidence"),
        providerMessageId: option("message-id"),
      }),
    ),
  );
}
main()
  .catch(() => {
    console.error("Purchase email reconciliation refused; check ID, state and evidence");
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
