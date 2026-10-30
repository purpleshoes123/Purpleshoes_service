import db from "../app/db.server";
import { getPurchaseEmailConfig } from "../app/domains/mail/purchase-policy";
import { processPurchaseEmailBatch } from "../app/domains/mail/purchase-worker.server.ts";
import { sendMailWithConfiguredProvider } from "../app/domains/mail/provider.server.ts";

let stopping = false;
let wake: (() => void) | undefined;
function shutdown() {
  stopping = true;
  wake?.();
}
const shouldStop = () => stopping;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, shutdown);
}
function waitForNextBatch() {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15000);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
async function main() {
  const config = getPurchaseEmailConfig();
  if (!config) {
    console.info("Purchase email worker disabled");
    return;
  }
  const { checkPurchaseReadiness } =
    await import("../app/domains/mail/purchase-readiness.server.ts");
  do {
    try {
      const counts = await processPurchaseEmailBatch({
        prisma: db,
        shop: config.shop,
        prepare: checkPurchaseReadiness,
        send: sendMailWithConfiguredProvider,
        shouldStop,
      });
      if (Object.values(counts).some(Boolean)) {
        console.info(JSON.stringify({ message: "Purchase email batch", ...counts }));
      }
    } catch {
      console.error("Purchase email batch failed; inspect provider/database configuration");
      if (!process.argv.includes("--watch")) {
        process.exitCode = 1;
        break;
      }
    }
    if (stopping || !process.argv.includes("--watch")) {
      break;
    }
    await waitForNextBatch();
  } while (!stopping);
}
main()
  .catch(() => {
    console.error("Purchase email worker configuration failed");
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
