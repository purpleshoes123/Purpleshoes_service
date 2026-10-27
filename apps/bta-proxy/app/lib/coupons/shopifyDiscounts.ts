import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { getCouponRulesConfig } from "./config";
import { normalizeId } from "./normalize";
import type { DiscountStatusResult } from "./types";

function toVariantGid(variantId: string): string {
  return variantId.startsWith("gid://")
    ? variantId
    : `gid://shopify/ProductVariant/${variantId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseGraphqlErrors(payload: any): string | null {
  if (payload?.errors && Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors.map((e: any) => e.message).join(", ");
  }
  return null;
}

function isFieldMissingError(message: string): boolean {
  return message.includes("doesn't exist") || message.includes("Cannot query field");
}

async function runGraphql(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>
): Promise<any> {
  const response = await admin.graphql(query, { variables });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed: ${response.status}`);
  }
  return await response.json();
}

export async function createGuide50DiscountCode(
  admin: AdminApiContext,
  params: { code: string; startsAt?: string; endsAt: string }
): Promise<{ code: string; discountId: string }>
export async function createGuide50DiscountCode(
  admin: AdminApiContext,
  params: { code: string; startsAt?: string; endsAt: string }
): Promise<{ code: string; discountId: string }> {
  const config = getCouponRulesConfig();
  const variantIds = Array.from(config.guideKitVariantIds)
    .map((id) => normalizeId(id))
    .filter((id): id is string => Boolean(id))
    .map(toVariantGid);

  let items: any = null;
  if (variantIds.length > 0) {
    items = { products: { productVariantsToAdd: variantIds } };
  } else {
    throw new Error("Guide Kit Bundle 대상 variant ID 설정이 필요합니다.");
  }

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) { nodes { code } }
              startsAt
              endsAt
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const payload = await runGraphql(admin, mutation, {
    basicCodeDiscount: {
      title: params.code,
      code: params.code,
      startsAt: params.startsAt || nowIso(),
      endsAt: params.endsAt,
      customerSelection: { all: true },
      customerGets: {
        items,
        value: { percentage: 0.5 },
      },
      combinesWith: {
        orderDiscounts: true,
        productDiscounts: true,
        shippingDiscounts: false,
      },
      usageLimit: 1,
      appliesOncePerCustomer: true,
    },
  });

  const error = parseGraphqlErrors(payload);
  if (error) {
    throw new Error(`GraphQL errors: ${error}`);
  }

  const userErrors = payload.data?.discountCodeBasicCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e: any) => e.message).join(", "));
  }

  const node = payload.data?.discountCodeBasicCreate?.codeDiscountNode;
  if (!node?.id) {
    throw new Error("Failed to create GUIDE50 discount code");
  }

  return { code: params.code, discountId: node.id };
}

export async function createExtra10DiscountCode(
  admin: AdminApiContext,
  params: { code: string }
): Promise<{ code: string; discountId: string }> {
  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) { nodes { code } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const payload = await runGraphql(admin, mutation, {
    basicCodeDiscount: {
      title: params.code,
      code: params.code,
      startsAt: nowIso(),
      customerSelection: { all: true },
      customerGets: {
        items: { all: true },
        value: { discountAmount: { amount: "10.0", appliesOnEachItem: false } },
      },
      combinesWith: {
        orderDiscounts: true,
        productDiscounts: true,
        shippingDiscounts: false,
      },
      usageLimit: 1,
      appliesOncePerCustomer: true,
    },
  });

  const error = parseGraphqlErrors(payload);
  if (error) {
    throw new Error(`GraphQL errors: ${error}`);
  }

  const userErrors = payload.data?.discountCodeBasicCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e: any) => e.message).join(", "));
  }

  const node = payload.data?.discountCodeBasicCreate?.codeDiscountNode;
  if (!node?.id) {
    throw new Error("Failed to create EXTRA10 discount code");
  }

  return { code: params.code, discountId: node.id };
}

export async function createTourPercentCode(
  admin: AdminApiContext,
  params: {
    code: string;
    kind: "TOUR5" | "TOUR15" | "TOUR20";
    variantIds: string[];
    startsAt?: string;
    endsAtHours?: number;
  }
): Promise<{ code: string; discountId: string }> {
  if (!params.variantIds || params.variantIds.length === 0) {
    throw new Error("Tour discount requires target variant IDs");
  }

  const variantGids = params.variantIds.map(toVariantGid);
  const percentageMap: Record<string, number> = {
    TOUR5: 0.05,
    TOUR15: 0.15,
    TOUR20: 0.2,
  };
  const percentage = percentageMap[params.kind];

  const endsAt =
    params.endsAtHours && params.endsAtHours > 0
      ? new Date(Date.now() + params.endsAtHours * 60 * 60 * 1000).toISOString()
      : undefined;

  const mutation = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              codes(first: 1) { nodes { code } }
              startsAt
              endsAt
            }
          }
        }
        userErrors { field message }
      }
    }
  `;

  const payload = await runGraphql(admin, mutation, {
    basicCodeDiscount: {
      title: params.code,
      code: params.code,
      startsAt: params.startsAt || nowIso(),
      ...(endsAt ? { endsAt } : {}),
      customerSelection: { all: true },
      customerGets: {
        items: { products: { productVariantsToAdd: variantGids } },
        value: { percentage },
      },
      combinesWith: {
        orderDiscounts: true,
        productDiscounts: false,
        shippingDiscounts: false,
      },
      usageLimit: 1,
      appliesOncePerCustomer: true,
    },
  });

  const error = parseGraphqlErrors(payload);
  if (error) {
    throw new Error(`GraphQL errors: ${error}`);
  }

  const userErrors = payload.data?.discountCodeBasicCreate?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e: any) => e.message).join(", "));
  }

  const node = payload.data?.discountCodeBasicCreate?.codeDiscountNode;
  if (!node?.id) {
    throw new Error("Failed to create TOUR discount code");
  }

  return { code: params.code, discountId: node.id };
}

async function tryMutation(
  admin: AdminApiContext,
  mutation: string,
  fieldName: string,
  id: string
): Promise<{ ok: boolean; unsupported?: boolean; error?: string } > {
  const payload = await runGraphql(admin, mutation, { id });
  const error = parseGraphqlErrors(payload);
  if (error) {
    if (isFieldMissingError(error)) {
      return { ok: false, unsupported: true, error };
    }
    return { ok: false, error };
  }

  const result = payload.data?.[fieldName];
  if (!result) {
    return { ok: false, error: "Unknown mutation response" };
  }

  const userErrors = result.userErrors || [];
  if (userErrors.length > 0) {
    return { ok: false, error: userErrors.map((e: any) => e.message).join(", ") };
  }

  return { ok: true };
}

export async function deactivateDiscountCode(
  admin: AdminApiContext,
  discountId: string
): Promise<void> {
  const mutations = [
    {
      field: "discountCodeDeactivate",
      query: `mutation discountCodeDeactivate($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message } } }`,
    },
    {
      field: "codeDiscountNodeDeactivate",
      query: `mutation codeDiscountNodeDeactivate($id: ID!) { codeDiscountNodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message } } }`,
    },
    {
      field: "discountCodeDelete",
      query: `mutation discountCodeDelete($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message } } }`,
    },
    {
      field: "codeDiscountNodeDelete",
      query: `mutation codeDiscountNodeDelete($id: ID!) { codeDiscountNodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message } } }`,
    },
  ];

  let lastError: string | undefined;
  for (const mutation of mutations) {
    const result = await tryMutation(admin, mutation.query, mutation.field, discountId);
    if (result.ok) {
      return;
    }
    if (!result.unsupported) {
      throw new Error(result.error || "Failed to deactivate discount");
    }
    lastError = result.error;
  }

  throw new Error(lastError || "Discount deactivate mutation not supported");
}

async function tryQuery(
  admin: AdminApiContext,
  query: string,
  fieldName: string,
  variables: Record<string, unknown>
): Promise<{ ok: boolean; unsupported?: boolean; data?: any; error?: string }> {
  const payload = await runGraphql(admin, query, variables);
  const error = parseGraphqlErrors(payload);
  if (error) {
    if (isFieldMissingError(error)) {
      return { ok: false, unsupported: true, error };
    }
    return { ok: false, error };
  }

  return { ok: true, data: payload.data?.[fieldName] };
}

export async function fetchDiscountStatusById(
  admin: AdminApiContext,
  discountId: string
): Promise<DiscountStatusResult> {
  const queries = [
    {
      field: "codeDiscountNode",
      query: `query codeDiscountNode($id: ID!) { codeDiscountNode(id: $id) { id codeDiscount { __typename ... on DiscountCodeBasic { status startsAt endsAt usageLimit asyncUsageCount } } } }`,
    },
    {
      field: "discountCodeNode",
      query: `query discountCodeNode($id: ID!) { discountCodeNode(id: $id) { id codeDiscount { __typename ... on DiscountCodeBasic { status startsAt endsAt usageLimit asyncUsageCount } } } }`,
    },
  ];

  let lastError: string | undefined;
  for (const query of queries) {
    const result = await tryQuery(admin, query.query, query.field, { id: discountId });
    if (!result.ok) {
      if (result.unsupported) {
        lastError = result.error;
        continue;
      }
      return { status: "unknown", reason: result.error };
    }

    if (!result.data) {
      return { status: "invalid", reason: "not_found" };
    }

    const codeDiscount = result.data.codeDiscount;
    if (!codeDiscount) {
      return { status: "invalid", reason: "not_found" };
    }

    const status = codeDiscount.status as string | undefined;
    const endsAt = codeDiscount.endsAt as string | null | undefined;
    const usageLimit =
      typeof codeDiscount.usageLimit === "number" ? codeDiscount.usageLimit : null;
    const usageCount =
      typeof codeDiscount.asyncUsageCount === "number"
        ? codeDiscount.asyncUsageCount
        : null;

    if (status && status !== "ACTIVE" && status !== "SCHEDULED") {
      return { status: "invalid", reason: status, endsAt: endsAt || null, usageLimit, usageCount };
    }

    if (endsAt) {
      const endsAtMs = Date.parse(endsAt);
      if (Number.isFinite(endsAtMs) && Date.now() > endsAtMs) {
        return { status: "invalid", reason: "expired", endsAt, usageLimit, usageCount };
      }
    }

    if (usageLimit !== null && usageLimit > 0 && usageCount !== null && usageCount >= usageLimit) {
      return {
        status: "invalid",
        reason: "usage_limit_reached",
        endsAt: endsAt || null,
        usageLimit,
        usageCount,
      };
    }

    return { status: "valid", endsAt: endsAt || null, usageLimit, usageCount };
  }

  return { status: "unknown", reason: lastError || "unsupported" };
}

export async function fetchDiscountStatusByCode(
  admin: AdminApiContext,
  code: string
): Promise<DiscountStatusResult> {
  const queries = [
    {
      field: "codeDiscountNodeByCode",
      query: `query codeDiscountNodeByCode($code: String!) { codeDiscountNodeByCode(code: $code) { id codeDiscount { __typename ... on DiscountCodeBasic { status startsAt endsAt usageLimit asyncUsageCount } } } }`,
    },
    {
      field: "discountCodeNodeByCode",
      query: `query discountCodeNodeByCode($code: String!) { discountCodeNodeByCode(code: $code) { id codeDiscount { __typename ... on DiscountCodeBasic { status startsAt endsAt usageLimit asyncUsageCount } } } }`,
    },
  ];

  let lastError: string | undefined;
  for (const query of queries) {
    const result = await tryQuery(admin, query.query, query.field, { code });
    if (!result.ok) {
      if (result.unsupported) {
        lastError = result.error;
        continue;
      }
      return { status: "unknown", reason: result.error };
    }

    if (!result.data) {
      return { status: "invalid", reason: "not_found" };
    }

    const codeDiscount = result.data.codeDiscount;
    if (!codeDiscount) {
      return { status: "invalid", reason: "not_found" };
    }

    const status = codeDiscount.status as string | undefined;
    const endsAt = codeDiscount.endsAt as string | null | undefined;
    const usageLimit =
      typeof codeDiscount.usageLimit === "number" ? codeDiscount.usageLimit : null;
    const usageCount =
      typeof codeDiscount.asyncUsageCount === "number"
        ? codeDiscount.asyncUsageCount
        : null;

    if (status && status !== "ACTIVE" && status !== "SCHEDULED") {
      return { status: "invalid", reason: status, endsAt: endsAt || null, usageLimit, usageCount };
    }

    if (endsAt) {
      const endsAtMs = Date.parse(endsAt);
      if (Number.isFinite(endsAtMs) && Date.now() > endsAtMs) {
        return { status: "invalid", reason: "expired", endsAt, usageLimit, usageCount };
      }
    }

    if (usageLimit !== null && usageLimit > 0 && usageCount !== null && usageCount >= usageLimit) {
      return {
        status: "invalid",
        reason: "usage_limit_reached",
        endsAt: endsAt || null,
        usageLimit,
        usageCount,
      };
    }

    return { status: "valid", endsAt: endsAt || null, usageLimit, usageCount };
  }

  return { status: "unknown", reason: lastError || "unsupported" };
}

export async function fetchDiscountIdByCode(
  admin: AdminApiContext,
  code: string
): Promise<string | null> {
  const queries = [
    {
      field: "codeDiscountNodeByCode",
      query:
        "query codeDiscountNodeByCode($code: String!) { codeDiscountNodeByCode(code: $code) { id } }",
    },
    {
      field: "discountCodeNodeByCode",
      query:
        "query discountCodeNodeByCode($code: String!) { discountCodeNodeByCode(code: $code) { id } }",
    },
  ];

  for (const query of queries) {
    const result = await tryQuery(admin, query.query, query.field, { code });
    if (!result.ok) {
      if (result.unsupported) continue;
      return null;
    }
    return result.data?.id || null;
  }
  return null;
}
