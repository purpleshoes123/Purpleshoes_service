/**
 * Tier Variant Pricing Service
 * productId → Tier Variant Table 구성 (Ticket Type × Pax Tier)
 */

import { loadOfflineSession, normalizeShopDomain } from "../../lib/shopifySession";
import { getCachedTierVariantTable, setCachedTierVariantTable } from "./tierVariantPricingCache";

export type TicketType = "Adult" | "Child" | "Infant";

export interface TierVariantCell {
  variantGid: string;
  variantId: string;
  unitPrice: number;
  paxTier: number;
  ticketType: TicketType;
}

export interface TierVariantTable {
  byTier: Record<number, Record<TicketType, TierVariantCell>>;
  byVariantId: Record<string, TicketType>;
}

const GET_PRODUCT_VARIANTS_QUERY = `
  query getProductVariants($productId: ID!) {
    product(id: $productId) {
      id
      variants(first: 100) {
        edges {
          node {
            id
            price
            selectedOptions {
              name
              value
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

function toGraphQLProductId(productId: string): string {
  if (productId.startsWith("gid://")) {
    return productId;
  }
  return `gid://shopify/Product/${productId}`;
}

function normalizeVariantId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = String(value);
  if (raw.startsWith("gid://")) {
    const parts = raw.split("/");
    return parts[parts.length - 1] || null;
  }
  return raw;
}

function parsePrice(price: string): number {
  const num = parseFloat(price);
  if (isNaN(num)) {
    throw new Error(`Invalid price format: ${price}`);
  }
  return Math.round(num);
}

function extractTicketType(
  selectedOptions: Array<{ name: string; value: string }>,
): TicketType | null {
  const ticketTypeOption = selectedOptions.find(
    (opt) => opt.name === "Ticket Type" || opt.name === "티켓 타입",
  );
  if (!ticketTypeOption) {
    return null;
  }
  const value = ticketTypeOption.value.trim();
  if (value.toLowerCase() === "adult" || value === "성인") {
    return "Adult";
  }
  if (value.toLowerCase() === "child" || value === "아동") {
    return "Child";
  }
  if (value.toLowerCase() === "infant" || value === "유아") {
    return "Infant";
  }
  return null;
}

function extractPaxTier(selectedOptions: Array<{ name: string; value: string }>): number | null {
  const paxTierOption = selectedOptions.find(
    (opt) => opt.name === "Pax Tier" || opt.name === "인원 티어",
  );
  if (!paxTierOption) {
    return null;
  }
  const value = paxTierOption.value.trim();
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return null;
  }
  return Math.trunc(num);
}

function isValidTierVariantTable(table: TierVariantTable): boolean {
  if (!table || typeof table !== "object") {
    return false;
  }
  if (!table.byTier || typeof table.byTier !== "object") {
    return false;
  }
  if (!table.byVariantId || typeof table.byVariantId !== "object") {
    return false;
  }
  if (Object.keys(table.byTier).length === 0) {
    return false;
  }
  const ticketTypes: TicketType[] = ["Adult", "Child", "Infant"];
  for (const [tierKey, row] of Object.entries(table.byTier)) {
    if (!row || typeof row !== "object") {
      return false;
    }
    const tierNum = Number(tierKey);
    if (!Number.isFinite(tierNum) || tierNum <= 0) {
      return false;
    }
    for (const type of ticketTypes) {
      const cell = (row as Record<TicketType, TierVariantCell>)[type];
      if (!cell) {
        return false;
      }
      if (cell.ticketType !== type) {
        return false;
      }
      if (cell.paxTier !== tierNum) {
        return false;
      }
      if (typeof cell.unitPrice !== "number" || !Number.isFinite(cell.unitPrice)) {
        return false;
      }
      if (!cell.variantId || typeof cell.variantId !== "string") {
        return false;
      }
    }
  }
  return true;
}

export async function getTierVariantTable(params: {
  productId: string;
  shop: string;
}): Promise<TierVariantTable> {
  const cached = await getCachedTierVariantTable(params.shop, params.productId);
  if (cached && isValidTierVariantTable(cached)) {
    return cached;
  }

  const session = await loadOfflineSession(params.shop, {
    source: "tierVariantPricingService",
  });
  if (!session) {
    throw new Error(`Session not found for shop: ${params.shop}. App may not be installed.`);
  }
  if (!session.accessToken) {
    throw new Error(`Access token is missing for shop: ${params.shop}`);
  }

  const graphqlId = toGraphQLProductId(params.productId);
  const apiVersionString = "2025-01";
  const adminShopDomain = session.shop || normalizeShopDomain(params.shop);
  const graphqlUrl = `https://${adminShopDomain}/admin/api/${apiVersionString}/graphql.json`;

  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: GET_PRODUCT_VARIANTS_QUERY,
      variables: {
        productId: graphqlId,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed with status ${response.status}`);
  }

  const responseJson = await response.json();
  if (responseJson.errors) {
    const errorMessages = responseJson.errors.map((e: any) => e.message).join(", ");
    throw new Error(`GraphQL error: ${errorMessages}`);
  }

  const product = responseJson.data?.product;
  if (!product) {
    throw new Error(`Product not found: ${params.productId}`);
  }

  const variants = product.variants?.edges || [];
  const pageInfo = product.variants?.pageInfo;

  // TODO: hasNextPage/endCursor 기반 pagination 추가 필요
  if (pageInfo?.hasNextPage) {
    console.warn(
      `Tier variants exceed first:100; pagination needed for product ${params.productId}`,
    );
  }

  const byTier: Record<number, Record<TicketType, TierVariantCell>> = {};
  const byVariantId: Record<string, TicketType> = {};
  let missingTicketType = 0;
  let missingPaxTier = 0;

  for (const edge of variants) {
    const variant = edge.node;
    const ticketType = extractTicketType(variant.selectedOptions || []);
    const paxTier = extractPaxTier(variant.selectedOptions || []);

    if (!ticketType) {
      missingTicketType += 1;
      continue;
    }
    if (!paxTier) {
      missingPaxTier += 1;
      continue;
    }

    const variantGid = variant.id as string;
    const variantId = normalizeVariantId(variantGid);
    if (!variantId) {
      continue;
    }

    const cell: TierVariantCell = {
      variantGid,
      variantId,
      unitPrice: parsePrice(variant.price),
      paxTier,
      ticketType,
    };

    if (!byTier[paxTier]) {
      byTier[paxTier] = {} as Record<TicketType, TierVariantCell>;
    }
    byTier[paxTier][ticketType] = cell;
    byVariantId[variantId] = ticketType;
  }

  if (Object.keys(byTier).length === 0) {
    throw new Error(`Pax Tier variants not found for product ${params.productId}`);
  }
  if (missingTicketType > 0 || missingPaxTier > 0) {
    console.warn(
      `Tier option missing for product ${params.productId} (ticketTypeMissing=${missingTicketType}, paxTierMissing=${missingPaxTier})`,
    );
  }
  const table: TierVariantTable = {
    byTier,
    byVariantId,
  };

  await setCachedTierVariantTable(params.shop, params.productId, table);
  return table;
}
