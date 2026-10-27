import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const url = new URL("/v1/health", request.url);
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    const body = await response.json();
    return json(body, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "요청 처리에 실패했습니다.",
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
};
