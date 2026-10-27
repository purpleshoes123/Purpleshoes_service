import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type {
  AttachProductAssetsInput,
  AttachResult,
} from "~/lib/adminProductAttachFiles/types";
import { attachHeroMedia } from "~/lib/adminProductAttachFiles/attachHeroMedia";
import { buildMetafieldsForTravel } from "~/lib/adminProductAttachFiles/buildMetafields";
import { setProductMetafields } from "~/lib/adminProductAttachFiles/setProductMetafields";

export async function attachFilesAndMetafields(
  adminClient: AdminApiContext,
  input: AttachProductAssetsInput
): Promise<AttachResult> {
  const steps: AttachResult["steps"] = [];

  if (!input.heroFileId) {
    throw new Error(
      `파일 누락: heroFileId가 필요합니다 (productId=${input.productId})`
    );
  }
  if (!input.heroPreviewUrl) {
    throw new Error(
      `파일 누락: heroPreviewUrl이 필요합니다 (productId=${input.productId})`
    );
  }
  if (!input.categoryImageFileId) {
    throw new Error(
      `파일 누락: categoryImageFileId가 필요합니다 (productId=${input.productId})`
    );
  }

  try {
    await attachHeroMedia(adminClient, input.productId, input.heroPreviewUrl);
    steps.push({ step: "attachHeroMedia", ok: true });
  } catch (error) {
    steps.push({
      step: "attachHeroMedia",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `attachFilesAndMetafields 실패: hero media 연결 실패 (productId=${input.productId}) steps=${JSON.stringify(
        steps
      )}`
    );
  }

  try {
    const metafields = buildMetafieldsForTravel(input);
    await setProductMetafields(adminClient, input.productId, metafields);
    steps.push({ step: "setProductMetafields", ok: true });
  } catch (error) {
    steps.push({
      step: "setProductMetafields",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw new Error(
      `attachFilesAndMetafields 실패: metafields 세팅 실패 (productId=${input.productId}) steps=${JSON.stringify(
        steps
      )}`
    );
  }

  return {
    productId: input.productId,
    steps,
  };
}
