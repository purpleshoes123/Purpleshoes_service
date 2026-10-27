import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type {
  AttachProductAssetsInput,
  AttachResult,
} from "~/lib/adminProductAttachFiles/types";
import { buildMetafieldsForTravel } from "~/lib/adminProductAttachFiles/buildMetafields";
import { setProductMetafields } from "~/lib/adminProductAttachFiles/setProductMetafields";

export async function attachMetafieldsOnly(
  adminClient: AdminApiContext,
  input: AttachProductAssetsInput
): Promise<AttachResult> {
  const steps: AttachResult["steps"] = [];

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
      `attachMetafieldsOnly 실패: metafields 세팅 실패 (productId=${input.productId}) steps=${JSON.stringify(
        steps
      )}`
    );
  }

  return {
    productId: input.productId,
    steps,
  };
}
