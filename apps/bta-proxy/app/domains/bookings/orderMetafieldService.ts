import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

type MetafieldResult = { ok: true } | { ok: false; message: string };

async function upsertOrderMetafield(args: {
  admin: AdminApiContext;
  orderId: string;
  key: string;
  value: string;
}): Promise<MetafieldResult> {
  const { admin, orderId, key, value } = args;
  const orderGid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;

  const mutation = `
    mutation setOrderMetafields($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key namespace value }
        userErrors { field message }
      }
    }
  `;

  try {
    const response = await admin.graphql(mutation, {
      variables: {
        metafields: [
          {
            namespace: "bta",
            key,
            ownerId: orderGid,
            type: "single_line_text_field",
            value,
          },
        ],
      },
    });

    if (!response.ok) {
      return { ok: false, message: `Shopify Admin API failed (${response.status})` };
    }

    const payload = (await response.json()) as {
      data?: {
        metafieldsSet?: {
          userErrors?: Array<{ message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    const errors = payload.errors || [];
    if (errors.length > 0) {
      return { ok: false, message: errors.map((e) => e.message).join(", ") };
    }

    const userErrors = payload.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length > 0) {
      return { ok: false, message: userErrors.map((e) => e.message).join(", ") };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function upsertOrderTravelDateMetafield(args: {
  admin: AdminApiContext;
  orderId: string;
  travelDate: string;
}): Promise<MetafieldResult> {
  return upsertOrderMetafield({
    admin: args.admin,
    orderId: args.orderId,
    key: "travel_date",
    value: args.travelDate,
  });
}

export async function upsertOrderBookingIdMetafield(args: {
  admin: AdminApiContext;
  orderId: string;
  bookingId: string;
}): Promise<MetafieldResult> {
  return upsertOrderMetafield({
    admin: args.admin,
    orderId: args.orderId,
    key: "booking_id",
    value: args.bookingId,
  });
}
