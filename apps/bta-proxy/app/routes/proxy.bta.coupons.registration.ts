import type { ActionFunctionArgs } from "react-router";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { activateRegistrationGuide50 } from "~/lib/coupons/registration";
import { respond } from "~/lib/respond";
import { completeVerifiedWebRegistration } from "~/lib/verifiedWebRegistration.server";
import { getCouponRedisClient } from "~/lib/coupons/redisClient";
import { getState } from "~/lib/coupons/state";
import { syncVerifiedWebMemberTag } from "~/lib/webMemberTag.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const invalid = await verifyAppProxy(request);
  if (invalid) return invalid;
  const correlationId = respond.getCorrelationId(request);
  const params = new URL(request.url).searchParams;
  const ids = params.getAll("logged_in_customer_id");
  // Only Shopify's signed session identity is proof of registration.
  // Newsletter payloads and caller-supplied customer_id/body values are not.
  if (ids.length !== 1 || !/^[1-9]\d*$/.test(ids[0])) {
    return respond.fail("AUTH_LOGIN_REQUIRED", "Please sign in first.", undefined, 401, correlationId);
  }
  const timestamps = params.getAll("timestamp");
  const timestamp = Number(timestamps[0]);
  if (timestamps.length !== 1 || !Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    return respond.fail("AUTH_PROXY_SIGNATURE_INVALID", "Request expired.", undefined, 401, correlationId);
  }
  const shop = extractShopFromRequest(request);
  if (!shop) return respond.fail("VALIDATION_ERROR", "Shop is required.", undefined, 400, correlationId);
  try {
    const admin = await getAdminApiClient(shop);
    if (!admin) throw new Error("Admin API session unavailable");
    if (process.env.NODE_ENV === "production" && !getCouponRedisClient()) throw new Error("Persistent registration state unavailable");
    const [offer, registration, memberTag] = await Promise.allSettled([
      activateRegistrationGuide50(admin, ids[0]),
      completeVerifiedWebRegistration(admin, shop, ids[0]),
      getState(ids[0]).then(state => syncVerifiedWebMemberTag(admin, ids[0], state)),
    ]);
    // Coupon provider failure must not suppress the verified member exit signal.
    if (offer.status === "rejected") throw offer.reason;
    if (registration.status === "rejected") throw registration.reason;
    if (memberTag.status === "rejected") throw memberTag.reason;
    return respond.withNoStore(respond.ok(offer.value, { correlationId }));
  } catch (error) {
    console.error(JSON.stringify({ message: "Verified registration needs retry/reconciliation", correlationId }));
    return respond.fail("INTERNAL_ERROR", "Please retry activating your welcome offer.", undefined, 503, correlationId);
  }
};
