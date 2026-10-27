import { json } from "~/lib/httpJson";
import { type LoaderFunctionArgs } from "react-router";
import { classifyPostPurchaseLines } from "~/lib/postPurchase/confirmation.server";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { authenticate } from "~/shopify.server";

function toOrderGid(value: string): string | null {
  const raw = value.trim();
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/Order/${raw}`;
  return null;
}
function shopFromDestination(destination?: string): string | null {
  if (!destination) return null;
  try {
    return new URL(destination).hostname || null;
  } catch {
    return destination.includes(".") ? destination : null;
  }
}

/**
 * Checkout UI extension endpoint.
 *
 * The extension session token is verified by Shopify. The response deliberately
 * contains only product category flags, never a viewer URL, download URL, buyer
 * identity, or booking details. Customer access continues through authenticated
 * My Page / Viewer APIs.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { sessionToken, cors } = await authenticate.public.checkout(request);
  const orderId = toOrderGid(params.orderId || "");
  const shop = shopFromDestination(sessionToken.dest);

  if (!orderId || !shop) {
    return cors(json({ ok: false, error: "Invalid order context." }, { status: 400 }));
  }

  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return cors(
      json({ ok: false, error: "Order confirmation is temporarily unavailable." }, { status: 503 })
    );
  }

  const response = await admin.graphql(
    `
      query PostPurchaseOrder($id: ID!) {
        order(id: $id) {
          id
          lineItems(first: 100) {
            edges {
              node {
                variant { id }
                product { productType }
              }
            }
          }
        }
      }
    `,
    { variables: { id: orderId } }
  );

  if (!response.ok) {
    return cors(
      json({ ok: false, error: "Order confirmation is temporarily unavailable." }, { status: 502 })
    );
  }

  const payload = (await response.json()) as {
    data?: {
      order?: {
        lineItems?: {
          edges?: Array<{
            node?: { variant?: { id?: string | null } | null; product?: { productType?: string | null } | null };
          }>;
        };
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length || !payload.data?.order) {
    return cors(json({ ok: false, error: "Order not found." }, { status: 404 }));
  }

  const lines = (payload.data.order.lineItems?.edges || []).map(({ node }) => ({
    variantId: node?.variant?.id || null,
    productType: node?.product?.productType || null,
  }));

  return cors(json({ ok: true, sections: classifyPostPurchaseLines(lines) }));
}
