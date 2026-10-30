import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type { TierPriceMatrix } from "./matrix";
import { ensureProductOptions } from "./ensureOptions";
import { fetchProductVariantsSnapshot } from "./fetchSnapshot";
import { buildUpsertPlan } from "./plan";
import { createMissingVariants } from "./createMissingVariants";
import { updateVariantPrices } from "./updateVariantPrices";

type UpsertTierVariantsResult = {
  productId: string;
  created: number;
  updated: number;
  deactivated: number;
};

export async function upsertTierVariants(
  adminClient: AdminApiContext,
  productId: string,
  matrix: TierPriceMatrix,
): Promise<UpsertTierVariantsResult> {
  const stepLogs: string[] = [];

  try {
    stepLogs.push("ensureProductOptions:start");
    await ensureProductOptions(adminClient, productId, matrix.maxPax);
    stepLogs.push("ensureProductOptions:ok");

    stepLogs.push("fetchSnapshot:start");
    const snapshot = await fetchProductVariantsSnapshot(adminClient, productId);
    stepLogs.push("fetchSnapshot:ok");

    stepLogs.push("buildUpsertPlan:start");
    const plan = buildUpsertPlan(snapshot, matrix);
    stepLogs.push(
      `buildUpsertPlan:ok creates=${plan.creates.length} updates=${plan.updates.length} deactivate=${plan.deactivate.length}`,
    );

    stepLogs.push("createMissingVariants:start");
    const createdIds = await createMissingVariants(adminClient, productId, plan.creates);
    stepLogs.push(`createMissingVariants:ok created=${createdIds.length}`);

    stepLogs.push("updateVariantPrices:start");
    await updateVariantPrices(adminClient, plan.updates, plan.deactivate);
    stepLogs.push("updateVariantPrices:ok");

    return {
      productId,
      created: createdIds.length,
      updated: plan.updates.length,
      deactivated: plan.deactivate.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`upsertTierVariants 실패: ${message}; steps=${stepLogs.join(" > ")}`);
  }
}
