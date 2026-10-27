import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { callGkvAdminApi, GkvAdminApiError } from "~/lib/gkv/adminApi.server";
import { authenticate } from "~/shopify.server";

type PreviewUrlResponse = {
  assetId: string;
  kind: "PDF" | "VIDEO";
  mimeType: string;
  previewUrl: string;
  expiresAt: string;
  ttlSec: number;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const assetId = params.assetId;
  if (!assetId) {
    return new Response("asset id가 필요합니다.", { status: 400 });
  }

  try {
    const data = await callGkvAdminApi<PreviewUrlResponse>(
      request,
      `/admin/gkv/assets/${encodeURIComponent(assetId)}/preview-url`
    );
    return redirect(data.previewUrl);
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return new Response(`파일 열람 URL을 발급하지 못했습니다: ${error.message}`, {
        status: error.status,
      });
    }

    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    return new Response(`파일 열람 URL을 발급하지 못했습니다: ${message}`, { status: 500 });
  }
};
