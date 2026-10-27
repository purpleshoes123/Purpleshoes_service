import type { ActionFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { verifyAdminApiKey } from "~/middleware/verifyAdminApiKey";
import { getAdminApiClient } from "~/lib/shopifyAdmin";

const DEFAULT_TITLE = "bta-proxy-storefront";

function parseJsonSafely(text: string): Record<string, unknown> | null {
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * POST /admin/storefront-token/create
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const authResponse = verifyAdminApiKey(request);
  if (authResponse) return authResponse;

  const url = new URL(request.url);
  const bodyText = await request.text();
  const body = parseJsonSafely(bodyText);
  if (body === null) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "JSON body 파싱에 실패했습니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const shop =
    (url.searchParams.get("shop") ||
      (typeof body.shop === "string" ? body.shop : ""))
      .trim();
  if (!shop) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "shop 파라미터가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const titleRaw = typeof body.title === "string" ? body.title.trim() : "";
  const title = titleRaw || DEFAULT_TITLE;

  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return respond.fail(
      ErrorCode.SHOPIFY_ADMIN_API_ERROR,
      getErrorMessage(
        ErrorCode.SHOPIFY_ADMIN_API_ERROR,
        "Shopify Admin API 세션을 찾을 수 없습니다."
      ),
      undefined,
      getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      correlationId
    );
  }

  const mutation = `
    mutation StorefrontAccessTokenCreate($input: StorefrontAccessTokenInput!) {
      storefrontAccessTokenCreate(input: $input) {
        storefrontAccessToken { accessToken title }
        userErrors { field message }
      }
    }
  `;

  const response = await admin.graphql(mutation, {
    variables: { input: { title } },
  });

  if (!response.ok) {
    let responseBody: string | null = null;
    try {
      responseBody = await response.text();
    } catch {
      responseBody = null;
    }
    console.error(
      JSON.stringify({
        message: "Storefront token create failed",
        shop,
        status: response.status,
        body: responseBody,
      })
    );
    return respond.fail(
      ErrorCode.SHOPIFY_ADMIN_API_ERROR,
      getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      {
        status: response.status,
        body: responseBody || undefined,
      },
      getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      correlationId
    );
  }

  const payload = (await response.json()) as {
    data?: {
      storefrontAccessTokenCreate?: {
        storefrontAccessToken?: { accessToken?: string; title?: string } | null;
        userErrors?: Array<{ field?: string[]; message?: string }>;
      } | null;
    };
    errors?: Array<{ message: string }>;
  };

  if (payload.errors && payload.errors.length > 0) {
    console.error(
      JSON.stringify({
        message: "Storefront token create graphql errors",
        shop,
        errors: payload.errors.map((e) => e.message),
      })
    );
    return respond.fail(
      ErrorCode.SHOPIFY_ADMIN_API_ERROR,
      getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      {
        errors: payload.errors.map((e) => e.message),
      },
      getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      correlationId
    );
  }

  const userErrors = payload.data?.storefrontAccessTokenCreate?.userErrors || [];
  if (userErrors.length > 0) {
    console.error(
      JSON.stringify({
        message: "Storefront token create userErrors",
        shop,
        userErrors: userErrors.map((e) => e.message),
      })
    );
    return respond.fail(
      ErrorCode.SHOPIFY_ADMIN_API_ERROR,
      getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      {
        userErrors: userErrors.map((e) => ({
          field: e.field,
          message: e.message,
        })),
      },
      getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      correlationId
    );
  }

  const token = payload.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
  const resolvedTitle =
    payload.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.title || title;

  if (!token) {
    return respond.fail(
      ErrorCode.SHOPIFY_ADMIN_API_ERROR,
      getErrorMessage(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      { reason: "missing_access_token" },
      getErrorStatus(ErrorCode.SHOPIFY_ADMIN_API_ERROR),
      correlationId
    );
  }

  return respond.ok(
    {
      ok: true,
      title: resolvedTitle,
      accessToken: token,
    },
    { correlationId }
  );
};
