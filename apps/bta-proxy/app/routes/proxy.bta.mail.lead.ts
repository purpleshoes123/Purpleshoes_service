import type { ActionFunctionArgs } from "react-router";
import db from "~/db.server";
import { sendSqueezeLead } from "~/lib/marketing/metaLead.server";
import { verifyLeadReceipt } from "~/lib/marketing/leadReceipt.server";
import { ErrorCode } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { extractShopFromRequest } from "~/lib/shopifyAdmin";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";

export const action = async ({ request }: ActionFunctionArgs) => {
  const rateLimitResponse = await enforceRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;
  const verifyResponse = await verifyAppProxy(request);
  if (verifyResponse) return verifyResponse;

  const correlationId = respond.getCorrelationId(request);
  const shopDomain = extractShopFromRequest(request);
  if (!shopDomain) return respond.fail(ErrorCode.MAILER_INVALID_INPUT, "Invalid shop", undefined, 400, correlationId);

  let body: Record<string, unknown>;
  try {
    if (!(request.headers.get("content-type") || "").includes("application/json")) throw new Error();
    body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
  } catch {
    return respond.fail(ErrorCode.MAILER_INVALID_INPUT, "Invalid request", undefined, 400, correlationId);
  }

  if (body.pagePath !== "/pages/squeezthank" || body.marketingAllowed !== true) {
    return respond.fail(ErrorCode.MAILER_INVALID_INPUT, "Invalid conversion context", undefined, 400, correlationId);
  }
  const requestId = verifyLeadReceipt(body.receipt as string, shopDomain);
  if (!requestId) return respond.fail(ErrorCode.MAILER_INVALID_INPUT, "Invalid conversion receipt", undefined, 400, correlationId);

  const record = await db.mailSendRequest.findUnique({ where: { id: requestId }, select: {
    recipientEmail: true, shopDomain: true, status: true, templateSlugSnapshot: true,
  } });
  if (!record || record.shopDomain !== shopDomain || record.status !== "SENT" ||
      record.templateSlugSnapshot?.toLowerCase() !== "squeeze") {
    return respond.fail(ErrorCode.MAILER_INVALID_INPUT, "No eligible submission", undefined, 400, correlationId);
  }

  // Verify the browser event independently of Meta delivery. No recipient data.
  if (body.verifyOnly === true) {
    return respond.withNoStore(respond.ok({ eligible: true, eventId: requestId, leadType: "starter_kit" }, { correlationId }));
  }

  // Atomic database claim across both ASG instances. A replay or refresh
  // cannot send another Lead even if it reaches a different server.
  const claim = await db.mailSendRequest.updateMany({
    where: { id: requestId, shopDomain, status: "SENT", metaLeadClaimedAt: null },
    data: { metaLeadClaimedAt: new Date() },
  });
  if (claim.count === 0) return respond.withNoStore(respond.ok({ recorded: false }, { correlationId }));

  try {
    await sendSqueezeLead({
      requestId,
      email: record.recipientEmail,
      fbc: typeof body.fbc === "string" ? body.fbc : undefined,
      fbp: typeof body.fbp === "string" ? body.fbp : undefined,
    });
    return respond.withNoStore(respond.ok({ recorded: true }, { correlationId }));
  } catch {
    // Do not reopen the claim: a timeout may mean Meta received the event.
    console.error("meta_lead_delivery_failed", { correlationId, requestId });
    return respond.fail(ErrorCode.INTERNAL_ERROR, "Lead delivery could not be confirmed", undefined, 503, correlationId);
  }
};
