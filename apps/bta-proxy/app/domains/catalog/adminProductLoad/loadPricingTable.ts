import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { fetchProductVariantsSnapshot } from "~/domains/catalog/adminVariantUpsert/fetchSnapshot";
import { parseVariantKey } from "~/domains/catalog/adminVariantUpsert/parse";
import type { TicketType } from "~/domains/catalog/adminProductUpsert/types";

type PricingRow = {
  tier: number;
  adult?: number;
  child?: number;
  infant?: number;
};

export type PricingTableLoadResult = {
  maxPax: number;
  rows: PricingRow[];
  missingCells: string[];
  zeroPriceCells: string[];
};

const TICKET_TYPES: TicketType[] = ["adult", "child", "infant"];

export async function loadPricingTableFromVariants(
  adminClient: AdminApiContext,
  productId: string,
  maxPax: number,
): Promise<PricingTableLoadResult> {
  if (!Number.isInteger(maxPax) || maxPax < 1) {
    throw new Error(`maxPax가 유효하지 않습니다: ${maxPax}`);
  }

  const snapshot = await fetchProductVariantsSnapshot(adminClient, productId);
  const map = new Map<string, number>();

  for (const variant of snapshot.variants) {
    const key = parseVariantKey(variant.selectedOptions);
    if (!key) {
      continue;
    }
    if (key.tier > maxPax) {
      continue;
    }
    map.set(`${key.tier}-${key.ticketType}`, variant.price);
  }

  const rows: PricingRow[] = [];
  const missingCells: string[] = [];
  const zeroPriceCells: string[] = [];

  for (let tier = 1; tier <= maxPax; tier += 1) {
    const row: PricingRow = { tier };
    for (const ticketType of TICKET_TYPES) {
      const key = `${tier}-${ticketType}`;
      const value = map.get(key);
      if (value == null) {
        missingCells.push(`tier ${tier} ${ticketType}`);
        continue;
      }
      if (value === 0) {
        zeroPriceCells.push(`tier ${tier} ${ticketType}`);
      }
      row[ticketType] = value;
    }
    rows.push(row);
  }

  return {
    maxPax,
    rows,
    missingCells,
    zeroPriceCells,
  };
}
