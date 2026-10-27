import { verifyAppProxy } from "./verifyAppProxy";
import { respond } from "~/lib/respond";

// Successful member prices and availability must not enter a shared cache.
export const memberRespond = {
  ...respond,
  ok: (...args: Parameters<typeof respond.ok>) => respond.withNoStore(respond.ok(...args)),
  fail: (...args: Parameters<typeof respond.fail>) => respond.withNoStore(respond.fail(...args)),
};

/** Price/booking endpoints require Shopify's signed customer identity.
 * User-supplied customer_id/customerId and a valid anonymous proxy signature
 * do not establish a customer login.
 */
export async function verifyMemberAppProxy(request: Request): Promise<Response | void> {
  const invalidSignature = await verifyAppProxy(request);
  if (invalidSignature) return respond.withNoStore(invalidSignature);

  const ids = new URL(request.url).searchParams.getAll("logged_in_customer_id");
  if (ids.length !== 1 || !/^[1-9][0-9]*$/.test(ids[0])) {
    return respond.withNoStore(respond.fail(
      "AUTH_LOGIN_REQUIRED",
      "Please sign in to view prices and booking availability.",
      undefined,
      401,
      respond.getCorrelationId(request),
    ));
  }
}
