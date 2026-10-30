import type { LoaderFunctionArgs } from "react-router";
import { memberRespond, verifyMemberAppProxy } from "~/middleware/verifyMemberAppProxy";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { getAdminApiClient, extractShopFromRequest } from "~/lib/shopifyAdmin";
import { buildCouponSummary } from "~/domains/coupons/display/summary";
import {
  MEMBER_TOURS,
  readMemberGuideCatalog,
} from "~/domains/checkout/privateCheckout/memberCatalog.server.ts";
import { resolveBookingPolicy } from "~/domains/bookings/bookingConfigResolver";
import { createBookingContext } from "~/domains/bookings/bookingContext.server.ts";
import { ErrorCode } from "~/lib/errors";
import { resolveCheckoutMode } from "~/domains/checkout/checkoutMode.server.ts";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const denied = await verifyMemberAppProxy(request);
  if (denied) {
    return denied;
  }
  const limited = await enforceRateLimit(request);
  if (limited) {
    return memberRespond.withNoStore(limited);
  }
  const correlationId = memberRespond.getCorrelationId(request);
  const fail = (status: number) =>
    memberRespond.fail(
      ErrorCode.VALIDATION_ERROR,
      "Member catalog unavailable",
      undefined,
      status,
      correlationId,
    );
  const url = new URL(request.url);
  const shop = extractShopFromRequest(request);
  const key = url.searchParams.get("key");
  if (!shop || url.searchParams.getAll("key").length !== 1 || !key) {
    return fail(400);
  }
  if (key !== "guide-plans" && !Object.hasOwn(MEMBER_TOURS, key)) {
    return fail(404);
  }
  try {
    if (
      resolveCheckoutMode(request, "guide", url.searchParams.get("logged_in_customer_id")!) !==
      "private_draft"
    ) {
      return fail(503);
    }
    const admin = await getAdminApiClient(shop);
    if (!admin) {
      return fail(503);
    }
    if (key === "guide-plans") {
      const summary = await buildCouponSummary({
        admin,
        customerId: url.searchParams.get("logged_in_customer_id")!,
      });
      return memberRespond.ok(await readMemberGuideCatalog(admin, summary), { correlationId });
    }
    const productId = MEMBER_TOURS[key];
    const response = await admin.graphql(
      `query MemberTourStatus($id: ID!) { product(id: $id) { status } }`,
      {
        variables: { id: `gid://shopify/Product/${productId}` },
      },
    );
    const result = (await response.json()) as {
      errors?: unknown[];
      data?: { product?: { status?: string } | null };
    };
    if (!response.ok || result.errors?.length || result.data?.product?.status !== "ACTIVE") {
      return fail(404);
    }
    const policy = await resolveBookingPolicy(productId, shop);
    const bookingContext = await createBookingContext(productId, shop);
    return memberRespond.ok(
      {
        kind: "tour",
        bookingContext,
        config: {
          maxPax: policy.maxPax,
          bookingWindowDays: policy.bookingWindowDays,
          operatingWeekdays: policy.operatingWeekdays,
          blackoutDates: policy.blackoutDates,
          bookingMode: policy.bookingMode,
          poolKey: policy.poolKey,
          guideUnitsRequired: policy.guideUnitsRequired,
          startTimeLabel: policy.startTimeLabel,
        },
      },
      { correlationId },
    );
  } catch {
    console.error("member_catalog_failed", { correlationId });
    return fail(503);
  }
};
