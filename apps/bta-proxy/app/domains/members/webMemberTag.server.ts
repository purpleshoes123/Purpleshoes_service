import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CouponState } from "../coupons/types";
import { patchState } from "../coupons/state";

export const WEB_MEMBER_TAG = "PS_회원";
export const ADD_WEB_MEMBER_TAG = `#graphql
  mutation AddWebMemberTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

// Coupon issuance alone is not registration proof: legacy lead records and
// manual coupon issuance can also have coupons. These timestamps are written
// by the signed, authenticated web-registration path.
export function hasVerifiedWebRegistration(
  state: Pick<CouponState, "webRegisteredAt" | "guide50RegisteredAt">,
): boolean {
  return [state.webRegisteredAt, state.guide50RegisteredAt].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
}

// Call only for a freshly authenticated web session, or a backfill record
// with verified registration evidence. This does not change consent/coupons.
export async function syncVerifiedWebMemberTag(
  admin: AdminApiContext,
  customerId: string,
  state: CouponState,
): Promise<void> {
  if (!/^[1-9]\d*$/.test(customerId)) {
    throw new Error("Invalid member ID");
  }
  if (state.webMemberTagSynced) {
    return;
  }
  const id = `gid://shopify/Customer/${customerId}`;
  try {
    const response = await admin.graphql(ADD_WEB_MEMBER_TAG, {
      variables: { id, tags: [WEB_MEMBER_TAG] },
      apiVersion: "2026-04",
    });
    if (!response.ok) {
      throw new Error();
    }
    const payload = await response.json();
    const result = payload.data?.tagsAdd;
    if (payload.errors?.length || result?.userErrors?.length || result?.node?.id !== id) {
      throw new Error();
    }
    await patchState(customerId, { webMemberTagSynced: true });
  } catch {
    throw new Error("Member tag sync unavailable; retry required");
  }
}
