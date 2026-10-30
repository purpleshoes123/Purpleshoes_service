import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type {
  DraftCreateInput,
  DraftCreateResult,
} from "~/domains/catalog/adminProductWriteDraft/types";
import { createDraftProductBase } from "~/domains/catalog/adminProductWriteDraft/createDraftProductBase";
import { setExternalKeyMetafield } from "~/domains/catalog/adminProductWriteDraft/setExternalKeyMetafield";

export async function createDraftBaseProductWithExternalKey(
  adminClient: AdminApiContext,
  input: DraftCreateInput,
): Promise<DraftCreateResult> {
  const stepLogs: string[] = [];

  stepLogs.push("createDraftProductBase");
  const result = await createDraftProductBase(adminClient, input);

  stepLogs.push("setExternalKeyMetafield");
  try {
    await setExternalKeyMetafield(adminClient, result.productId, input.externalKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `external_key 세팅 실패: ${message} (productId=${result.productId}, stepLogs=${stepLogs.join(",")})`,
    );
  }

  return result;
}
