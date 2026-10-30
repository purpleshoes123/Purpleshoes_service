import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { canPublishProduct } from "~/domains/catalog/adminPublishProduct/canPublishProduct";
import { setProductActive } from "~/domains/catalog/adminPublishProduct/setProductActive";
import { publishProductToChannels } from "~/domains/catalog/adminPublishProduct/publishProductToChannels";
import { assertPublicationAccess } from "./assertPublicationAccess";

export type PublishOrchestratorInput = {
  productId: string;
  publicationIds: string[];
  maxPax: number;
};

export type PublishOrchestratorResult = {
  productId: string;
  status: string;
  publishableId: string;
};

export async function publishOrchestrator(
  adminClient: AdminApiContext,
  input: PublishOrchestratorInput,
): Promise<PublishOrchestratorResult> {
  const { productId, publicationIds, maxPax } = input;
  await assertPublicationAccess(adminClient);

  // Gate 체크: 실패 시 throw (Active 전환도 하지 않음)
  const gate = await canPublishProduct(adminClient, productId, maxPax);
  if (!gate.ok) {
    throw new Error(`publish 게이트 실패: ${gate.reasons.join(", ")}; productId=${productId}`);
  }

  // Active 전환
  const activeResult = await setProductActive(adminClient, productId);

  // Publish
  const publishResult = await publishProductToChannels(adminClient, productId, publicationIds);

  return {
    productId: activeResult.productId,
    status: activeResult.status,
    publishableId: publishResult.publishableId,
  };
}
