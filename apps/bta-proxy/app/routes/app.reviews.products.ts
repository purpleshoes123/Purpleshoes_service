import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { logEvent } from "~/lib/logEvent";

function escapeQueryValue(value: string): string {
  return value.replace(/"/g, "\\\"");
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const startTime = Date.now();

  try {
    const auth = await authenticate.admin(request);
    const shop = auth.session.shop;
    const url = new URL(request.url);
    const rawQuery = url.searchParams.get("q") || "";
    const trimmed = rawQuery.trim();

    if (trimmed.length < 2) {
      logEvent(
        "review.admin.product_search.fail",
        {
          path: url.pathname,
          method: "GET",
          errorCode: ErrorCode.REVIEW_INVALID_INPUT,
          reason: "query_too_short",
          durationMs: Date.now() - startTime,
        },
        { correlationId, shop, severity: "warn" }
      );
      return respond.fail(
        ErrorCode.REVIEW_INVALID_INPUT,
        getErrorMessage(
          ErrorCode.REVIEW_INVALID_INPUT,
          "검색어는 최소 2자 이상이어야 합니다."
        ),
        undefined,
        getErrorStatus(ErrorCode.REVIEW_INVALID_INPUT),
        correlationId
      );
    }

    const query = `status:active title:*${escapeQueryValue(trimmed)}*`;

    logEvent(
      "review.admin.product_search.attempt",
      {
        path: url.pathname,
        method: "GET",
        queryLength: trimmed.length,
      },
      { correlationId, shop }
    );

    const PRODUCTS_QUERY = `
      query listProducts($first: Int!, $query: String!) {
        products(first: $first, query: $query) {
          edges {
            node {
              id
              title
            }
          }
        }
      }
    `;

    const response = await auth.admin.graphql(PRODUCTS_QUERY, {
      variables: {
        first: 20,
        query,
      },
    });

    if (!response.ok) {
      throw new Error(`Shopify Admin API request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: {
        products?: {
          edges?: Array<{ node: { id: string; title: string } }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (payload.errors && payload.errors.length > 0) {
      throw new Error(payload.errors.map((e) => e.message).join(", "));
    }

    const items = (payload.data?.products?.edges || []).map((edge) => edge.node);

    logEvent(
      "review.admin.product_search.success",
      {
        path: url.pathname,
        method: "GET",
        count: items.length,
        durationMs: Date.now() - startTime,
      },
      { correlationId, shop }
    );

    return respond.ok({ items }, { correlationId });
  } catch (error) {
    if (error instanceof Response) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logEvent(
      "review.admin.product_search.fail",
      {
        path: new URL(request.url).pathname,
        method: "GET",
        errorCode: ErrorCode.REVIEW_SHOPIFY_API_ERROR,
        reason: message,
        durationMs: Date.now() - startTime,
      },
      { correlationId, severity: "error" }
    );

    return respond.fail(
      ErrorCode.REVIEW_SHOPIFY_API_ERROR,
      getErrorMessage(ErrorCode.REVIEW_SHOPIFY_API_ERROR, message),
      undefined,
      getErrorStatus(ErrorCode.REVIEW_SHOPIFY_API_ERROR),
      correlationId
    );
  }
};
