import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";
import { authenticate } from "~/shopify.server";

type AdminHealthData = {
  status: string;
  scope: string;
  service: string;
  enabled: boolean;
  strictMode: boolean;
  db: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  try {
    const data = await callGkvAdminApi<AdminHealthData>(request, "/admin/health");
    return json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json(
        {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details ?? null,
          },
        },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    return json(
      {
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "요청 처리에 실패했습니다.",
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
};
