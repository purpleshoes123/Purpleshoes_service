import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { extractShopFromRequest, getAdminApiClient } from "~/lib/shopifyAdmin";
import { normalizeShopDomain } from "~/lib/shopifySession";

type ListTravelProductsResponse = {
  data?: {
    products?: {
      edges?: Array<{
        node?: {
          id?: string | null;
          handle?: string | null;
          title?: string | null;
          description?: string | null;
          onlineStoreUrl?: string | null;
          featuredImage?: {
            url?: string | null;
            altText?: string | null;
          } | null;
        } | null;
      } | null>;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

const LIST_TRAVEL_PRODUCTS_QUERY = `
  query listTravelProducts($first: Int!, $query: String!) {
    products(first: $first, query: $query, sortKey: UPDATED_AT, reverse: true) {
      edges {
        node {
          id
          handle
          title
          description
          onlineStoreUrl
          featuredImage {
            url
            altText
          }
        }
      }
    }
  }
`;

function extractTaxonomyCategoryId(taxonomyNodeId: string | undefined): string | null {
  if (!taxonomyNodeId) {
    return null;
  }
  const trimmed = taxonomyNodeId.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.includes("/")) {
    return trimmed;
  }
  const matched = trimmed.match(/TaxonomyCategory\/([^/?#]+)/);
  return matched?.[1] || null;
}

function buildTravelProductSearchQuery(): string | null {
  const taxonomyNodeId = (process.env.TRAVEL_TAXONOMY_NODE_ID || "").trim();
  const taxonomyCategoryId = extractTaxonomyCategoryId(taxonomyNodeId) || "";

  if (taxonomyCategoryId) {
    return `status:active category_id:${taxonomyCategoryId}`;
  }

  return null;
}

function buildProductUrl(params: {
  shop: string;
  handle?: string | null;
  onlineStoreUrl?: string | null;
}): string {
  const onlineStoreUrl = params.onlineStoreUrl?.trim();
  if (onlineStoreUrl) {
    return onlineStoreUrl;
  }

  const handle = params.handle?.trim();
  if (!handle) {
    return "";
  }

  return `https://${params.shop}/products/${encodeURIComponent(handle)}`;
}

function normalizeShopCandidate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeShopDomain(raw);
  if (!normalized) {
    return null;
  }
  if (normalized.includes(".")) {
    return normalized;
  }
  return `${normalized}.myshopify.com`;
}

async function resolveShopForPublicRequest(request: Request): Promise<string | null> {
  const fromQuery = extractShopFromRequest(request);
  if (fromQuery) {
    return fromQuery;
  }

  const fromHeader = normalizeShopCandidate(
    request.headers.get("X-Shopify-Shop-Domain") || request.headers.get("X-Shop-Domain"),
  );
  if (fromHeader) {
    return fromHeader;
  }

  const fromEnv = normalizeShopCandidate(
    process.env.GKV_DEFAULT_SHOP || process.env.REBUILD_AUTO_SHOPS?.split(",")[0],
  );
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const sessions = await prisma.session.findMany({
      select: { shop: true, isOnline: true },
      distinct: ["shop"],
      orderBy: [{ shop: "asc" }],
    });
    const offlineShop = sessions.find((session) => session.isOnline === false)?.shop;
    return normalizeShopCandidate(offlineShop || sessions[0]?.shop || null);
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  const query = buildTravelProductSearchQuery();
  if (!query) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(
        ErrorCode.VALIDATION_ERROR,
        "TRAVEL_TAXONOMY_NODE_ID 환경변수가 필요합니다. (예: gid://shopify/TaxonomyCategory/se-4-7)",
      ),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  const shop = await resolveShopForPublicRequest(request);
  if (!shop) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(
        ErrorCode.VALIDATION_ERROR,
        "shop 컨텍스트를 찾을 수 없습니다. shop 파라미터, X-Shopify-Shop-Domain 헤더, GKV_DEFAULT_SHOP 또는 세션 설정을 확인해주세요.",
      ),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    const admin = await getAdminApiClient(shop);
    if (!admin) {
      return respond.fail(
        ErrorCode.SHOPIFY_ADMIN_API_ERROR,
        getErrorMessage(
          ErrorCode.SHOPIFY_ADMIN_API_ERROR,
          "Admin API 클라이언트를 찾을 수 없습니다.",
        ),
        undefined,
        getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
        correlationId,
      );
    }

    const response = await admin.graphql(LIST_TRAVEL_PRODUCTS_QUERY, {
      variables: {
        first: 50,
        query,
      },
    });

    if (!response.ok) {
      return respond.fail(
        ErrorCode.SHOPIFY_ADMIN_API_ERROR,
        getErrorMessage(
          ErrorCode.SHOPIFY_ADMIN_API_ERROR,
          `Shopify Admin API status=${response.status}`,
        ),
        undefined,
        getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
        correlationId,
      );
    }

    const payload = (await response.json()) as ListTravelProductsResponse;
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors
        .map((error) => error?.message)
        .filter((value): value is string => Boolean(value))
        .join(", ");

      return respond.fail(
        ErrorCode.SHOPIFY_ADMIN_API_ERROR,
        getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_ERROR, message || "Unknown GraphQL error"),
        undefined,
        getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
        correlationId,
      );
    }

    const items = (payload.data?.products?.edges || [])
      .map((edge) => edge?.node)
      .filter(
        (
          node,
        ): node is {
          id: string;
          handle?: string | null;
          title?: string | null;
          description?: string | null;
          onlineStoreUrl?: string | null;
          featuredImage?: { url?: string | null; altText?: string | null } | null;
        } => Boolean(node?.id),
      )
      .map((node) => ({
        id: node.id,
        productUrl: buildProductUrl({
          shop,
          handle: node.handle,
          onlineStoreUrl: node.onlineStoreUrl,
        }),
        title: node.title || "",
        description: node.description || "",
        representativeImage: {
          url: node.featuredImage?.url || "",
          altText: node.featuredImage?.altText || null,
        },
      }));

    return respond.ok({ items }, { correlationId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout =
      message.toLowerCase().includes("timeout") ||
      (error instanceof Error && error.name === "TimeoutError");

    const code = isTimeout
      ? ErrorCode.SHOPIFY_ADMIN_API_TIMEOUT
      : ErrorCode.SHOPIFY_ADMIN_API_ERROR;

    return respond.fail(
      code,
      getErrorMessage(code, message),
      undefined,
      getErrorStatus(code),
      correlationId,
    );
  }
};
