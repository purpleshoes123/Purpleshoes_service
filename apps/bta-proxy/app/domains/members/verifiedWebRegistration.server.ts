import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { searchCustomers } from "./shopifyCustomerSearch.server.ts";
import { getState, patchState } from "../coupons/state";
import { acquireLock, releaseLock } from "../coupons/lock";
import { sendCustomerRegistrationMail } from "../mail/service.server.ts";
import { sendKlaviyoAccountRegistrationEvent } from "../mail/klaviyoEvent.server.ts";

/** Called only after fresh proxy HMAC + authenticated customer ID verification.
 * Email/name come from Admin API, never from the request body. */
export async function completeVerifiedWebRegistration(
  admin: AdminApiContext,
  shop: string,
  customerId: string,
) {
  const lock = `verifiedRegistration:${shop}`;
  if (!(await acquireLock(lock, customerId, 120))) {
    throw new Error("Registration is being processed");
  }
  try {
    const state = await getState(customerId);
    if (state.webRegistrationMailComplete && state.webRegistrationKlaviyoComplete) {
      return;
    }
    const customers = await searchCustomers(admin, customerId);
    const customer = customers.find((item) => item.id === `gid://shopify/Customer/${customerId}`);
    if (!customer?.email || !customer.email.includes("@")) {
      throw new Error("Registered customer unavailable");
    }
    const registeredAt =
      state.webRegisteredAt || state.guide50RegisteredAt || Math.floor(Date.now() / 1000);
    await patchState(customerId, { webRegisteredAt: registeredAt });
    // Stop lead reminders independently of email success. Event unique_id is
    // stable even if a request retries after Redis's processing lock expires.
    if (!state.webRegistrationKlaviyoComplete) {
      const result = await sendKlaviyoAccountRegistrationEvent({
        input: {
          shopDomain: shop,
          customerId,
          recipientEmail: customer.email,
          recipientName: customer.displayName,
          registeredAt: new Date(registeredAt * 1000).toISOString(),
        },
      });
      if (result.status !== "SENT") {
        throw new Error("Registration exit signal unavailable");
      }
      await patchState(customerId, { webRegistrationKlaviyoComplete: true });
    }
    if (!state.webRegistrationMailComplete) {
      await sendCustomerRegistrationMail({
        registrationSource: "verified-web-session",
        shopDomain: shop,
        customerId,
        recipientEmail: customer.email,
        recipientName: customer.displayName,
      });
      await patchState(customerId, { webRegistrationMailComplete: true });
    }
  } finally {
    await releaseLock(lock, customerId);
  }
}
