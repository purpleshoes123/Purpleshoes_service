import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { enforceRateLimit } from "~/middleware/rateLimit";
import { verifyAppProxy } from "~/middleware/verifyAppProxy";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { extractCustomerIdFromProxyRequest } from "~/domains/checkout/guideExtension/customerId";

const NAMESPACE = "bta_my_page";
const KEY = "hidden_order_ids";
const hideSchema = z.object({ action: z.literal("hide"), orderId: z.string().trim().min(1) });

function orderGid(orderId: string): string {
  return orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
}

function parseIds(value?: string | null): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string" && /^\d+$/.test(item))
          .slice(0, 250)
      : [];
  } catch {
    return [];
  }
}

async function getHiddenOrderIds(
  admin: NonNullable<Awaited<ReturnType<typeof getAdminApiClient>>>,
  customerId: string,
) {
  const response = await admin.graphql(
    `
    query hiddenOrderIds($id: ID!) {
      customer(id: $id) { metafield(namespace: "${NAMESPACE}", key: "${KEY}") { value } }
    }
  `,
    { variables: { id: customerId } },
  );
  if (!response.ok) {
    throw new Error("Unable to read hidden order list.");
  }
  const payload = (await response.json()) as {
    data?: { customer?: { metafield?: { value?: string | null } | null } | null };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(", "));
  }
  return parseIds(payload.data?.customer?.metafield?.value);
}

async function assertCustomerOwnsOrder(
  admin: NonNullable<Awaited<ReturnType<typeof getAdminApiClient>>>,
  customerId: string,
  rawOrderId: string,
) {
  const response = await admin.graphql(
    `
    query orderOwner($id: ID!) { order(id: $id) { customer { id } } }
  `,
    { variables: { id: orderGid(rawOrderId) } },
  );
  if (!response.ok) {
    throw new Error("Unable to verify order ownership.");
  }
  const payload = (await response.json()) as {
    data?: { order?: { customer?: { id?: string | null } | null } | null };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(", "));
  }
  if (payload.data?.order?.customer?.id !== customerId) {
    throw new Error("Order is not owned by this customer.");
  }
}

async function context(request: Request) {
  const shop = extractShopFromRequest(request);
  const customerId = extractCustomerIdFromProxyRequest(request);
  if (!shop || !customerId) {
    return null;
  }
  const admin = await getAdminApiClient(shop);
  if (!admin) {
    throw new Error("Shopify Admin API session is unavailable.");
  }
  return { admin, customerId };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const limited = await enforceRateLimit(request);
  if (limited) {
    return limited;
  }
  const verified = await verifyAppProxy(request);
  if (verified) {
    return verified;
  }
  const correlationId = respond.getCorrelationId(request);
  try {
    const result = await context(request);
    if (!result) {
      return respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
        correlationId,
      );
    }
    return respond.ok(
      { hiddenOrderIds: await getHiddenOrderIds(result.admin, result.customerId) },
      { correlationId },
    );
  } catch (error) {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      error instanceof Error ? error.message : getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const limited = await enforceRateLimit(request);
  if (limited) {
    return limited;
  }
  const verified = await verifyAppProxy(request);
  if (verified) {
    return verified;
  }
  const correlationId = respond.getCorrelationId(request);
  try {
    const result = await context(request);
    if (!result) {
      return respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
        correlationId,
      );
    }
    const input = hideSchema.parse(await request.json());
    await assertCustomerOwnsOrder(result.admin, result.customerId, input.orderId);
    const current = await getHiddenOrderIds(result.admin, result.customerId);
    const hiddenOrderIds = Array.from(new Set([...current, input.orderId])).slice(-250);
    const response = await result.admin.graphql(
      `
      mutation hideOrder($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { message } }
      }
    `,
      {
        variables: {
          metafields: [
            {
              ownerId: result.customerId,
              namespace: NAMESPACE,
              key: KEY,
              type: "json",
              value: JSON.stringify(hiddenOrderIds),
            },
          ],
        },
      },
    );
    if (!response.ok) {
      throw new Error("Unable to save hidden order list.");
    }
    const payload = (await response.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
      errors?: Array<{ message: string }>;
    };
    const messages = [
      ...(payload.errors || []),
      ...(payload.data?.metafieldsSet?.userErrors || []),
    ].map((error) => error.message);
    if (messages.length) {
      throw new Error(messages.join(", "));
    }
    return respond.ok({ hiddenOrderIds }, { correlationId });
  } catch (error) {
    return respond.fail(
      ErrorCode.REVIEW_INVALID_INPUT,
      error instanceof Error ? error.message : getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
      correlationId,
    );
  }
};
