import { createHash } from "node:crypto";
import type { MailerDbClient } from "./store.shared.ts";

export function registrationDeliveryId(shop: string, customerId: string) {
  return `registration_${createHash("sha256").update(`${shop}:${customerId}`).digest("hex")}`;
}

/** Atomic primary-key claim across processes/restarts. Never auto-resend an
 * existing FAILED/PENDING request: provider acceptance may be ambiguous. */
export async function claimRegistrationDelivery(
  prisma: MailerDbClient,
  input: {
    shopDomain: string;
    customerId: string;
    templateId: string;
    recipientEmail: string;
    recipientName?: string | null;
    emailProvider: string;
  },
) {
  const requestKey = `customers/create:${input.customerId}:register-no-squeeze`;
  const legacy = await prisma.mailSendRequest.findFirst({
    where: {
      shopDomain: input.shopDomain,
      requestKey: { in: [requestKey, `customers/create:${input.customerId}:register`] },
      status: "SENT",
    },
    orderBy: { createdAt: "asc" },
  });
  if (legacy) {
    return { claimed: false, request: legacy };
  }
  const id = registrationDeliveryId(input.shopDomain, input.customerId);
  try {
    const request = await prisma.mailSendRequest.create({
      data: {
        id,
        shopDomain: input.shopDomain,
        templateId: input.templateId,
        requestSource: "INTERNAL_TRIGGER",
        requestKey,
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName || null,
        emailProvider: input.emailProvider,
        status: "PENDING",
        pagePath: "/proxy/bta/coupons/registration",
        userAgent: "verified-web-registration",
      },
    });
    return { claimed: true, request };
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "P2002") {
      throw error;
    }
    const request = await prisma.mailSendRequest.findUnique({ where: { id } });
    if (!request || request.shopDomain !== input.shopDomain) {
      throw error;
    }
    return { claimed: false, request };
  }
}
