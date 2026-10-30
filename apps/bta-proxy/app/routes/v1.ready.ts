import prisma from "~/db.server";
import { getRedisBookingClient } from "~/domains/bookings/bookingStore";
import { checkReadiness } from "~/lib/readiness.server";
import { assertCouponMigrationVerified } from "~/domains/coupons/durableState.server.ts";
import { assertBookingJournalReady } from "~/domains/bookings/bookingMutation.server.ts";
import { getRedisRateLimitCounterStore } from "~/lib/rateLimit/rateLimitStore.server";

// Dedicated ALB target check. Keep the old public liveness endpoint unchanged.
// Do not enable multi-node mode until configuration and state migration pass.
export async function loader() {
  const headers = { "Cache-Control": "no-store" };
  if (process.env.DEPLOYMENT_MODE !== "multi-node") {
    return new Response(null, { status: 404, headers });
  }
  const ready = await checkReadiness({
    database: async () => {
      await prisma.$queryRaw`SELECT 1`;
      await assertCouponMigrationVerified();
      await assertBookingJournalReady();
    },
    sharedState: async () => {
      // Rate limiting uses its own lazy connection with offline queuing disabled.
      // Warm it here so the first real customer request does not receive a 503.
      const rateLimitStore = getRedisRateLimitCounterStore();
      const client = getRedisBookingClient();
      if (!rateLimitStore || !(await rateLimitStore.isReady())) {
        return false;
      }
      // Do not enqueue health probes while Redis is offline/reconnecting.
      if (!client || client.status !== "ready") {
        return false;
      }
      if ((await client.ping()) !== "PONG") {
        return false;
      }
      const replication = await client.info("replication");
      return /^role:master\r?$/m.test(replication);
    },
  });
  return Response.json(
    { status: ready ? "ready" : "unavailable" },
    { status: ready ? 200 : 503, headers },
  );
}
