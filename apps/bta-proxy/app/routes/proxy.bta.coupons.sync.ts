import type { ActionFunctionArgs } from "react-router";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { handleCouponsSync } from "~/lib/coupons/syncHandler";

/**
 * POST /proxy/bta/coupons/sync
 * App Proxy 서명 검증 필요
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  return await handleCouponsSync(request);
};
