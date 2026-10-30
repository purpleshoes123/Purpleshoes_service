import type { ActionFunctionArgs } from "react-router";
import { handleCouponsSync } from "~/domains/coupons/syncHandler";
import { verifyAdminApiKey } from "~/middleware/verifyAdminApiKey";

/**
 * POST /coupons/sync
 * 내부 디버그/개발용. ADMIN_API_KEY가 설정되어 있으면 검증.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (process.env.ADMIN_API_KEY) {
    const authResponse = verifyAdminApiKey(request);
    if (authResponse) {
      return authResponse;
    }
  }

  return await handleCouponsSync(request);
};
