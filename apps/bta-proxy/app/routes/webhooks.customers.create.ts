import type { ActionFunctionArgs } from "react-router";
import { verifyWebhook } from "~/middleware/verifyWebhook";

/** Customer records include newsletter leads and guests, not just members.
 * Only the authenticated app-proxy route owns registration side effects. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const verification = await verifyWebhook(request);
  if (!verification.verified) return verification.response;
  try { JSON.parse(verification.rawBody); }
  catch { return new Response("Invalid JSON", { status: 400 }); }
  return new Response("OK", { status: 200 });
};
