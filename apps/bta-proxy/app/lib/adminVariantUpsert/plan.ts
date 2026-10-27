import type { ProductVariantsSnapshot } from "./productSnapshotQuery";
import type { TierPriceMatrix } from "./matrix";
import { parseVariantKey } from "./parse";

export type VariantUpdate = { id: string; price: number };

export type VariantCreate = {
  ticketType: "adult" | "child" | "infant";
  tier: number;
  price: number;
};

export type UpsertPlan = {
  updates: VariantUpdate[];
  creates: VariantCreate[];
  deactivate: string[];
  noop: string[];
};

type ExistingVariant = {
  id: string;
  price: number;
};

export function buildUpsertPlan(
  snapshot: ProductVariantsSnapshot,
  matrix: TierPriceMatrix
): UpsertPlan {
  const existingMap = new Map<string, ExistingVariant>();
  const deactivate: string[] = [];

  for (const variant of snapshot.variants) {
    const key = parseVariantKey(variant.selectedOptions);
    if (!key) {
      continue;
    }

    if (key.tier > matrix.maxPax) {
      deactivate.push(variant.id);
      continue;
    }

    const mapKey = `${key.ticketType}-${key.tier}`;
    existingMap.set(mapKey, { id: variant.id, price: variant.price });
  }

  const creates: VariantCreate[] = [];
  const updates: VariantUpdate[] = [];
  const noop: string[] = [];

  const ticketTypes: Array<VariantCreate["ticketType"]> = [
    "adult",
    "child",
    "infant",
  ];

  for (let tier = 1; tier <= matrix.maxPax; tier += 1) {
    const tierPrices = matrix.tiers[tier];
    for (const ticketType of ticketTypes) {
      const desiredKey = `${ticketType}-${tier}`;
      const desiredPrice = tierPrices[ticketType];
      const existing = existingMap.get(desiredKey);

      if (!existing) {
        creates.push({ ticketType, tier, price: desiredPrice });
        continue;
      }

      if (existing.price !== desiredPrice) {
        updates.push({ id: existing.id, price: desiredPrice });
      } else {
        noop.push(existing.id);
      }
    }
  }

  return {
    updates,
    creates,
    deactivate,
    noop,
  };
}
