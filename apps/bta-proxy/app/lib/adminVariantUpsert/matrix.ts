import type { PriceTable, TicketType } from "../adminProductUpsert/types";

export type TierPriceMatrix = {
  maxPax: number;
  tiers: Record<number, { adult: number; child: number; infant: number }>;
};

const EXPECTED_TICKET_TYPES: TicketType[] = ["adult", "child", "infant"];

export function toTierPriceMatrix(input: {
  maxPax: number;
  pricingTable: PriceTable;
}): TierPriceMatrix {
  const { maxPax, pricingTable } = input;

  if (!Number.isInteger(maxPax) || maxPax < 1) {
    throw new Error(`maxPax가 유효하지 않습니다: ${maxPax}`);
  }

  const tierNumbers = pricingTable.tiers.map((tier) => tier.paxTier);
  const uniqueTiers = new Set(tierNumbers);
  if (uniqueTiers.size !== tierNumbers.length) {
    throw new Error("pricingTable.tiers에 중복된 paxTier가 있습니다.");
  }

  for (let i = 1; i <= maxPax; i += 1) {
    if (!uniqueTiers.has(i)) {
      throw new Error(`pricingTable.tiers는 1..N 연속이어야 합니다. (누락: ${i})`);
    }
  }

  const tiers: Record<number, { adult: number; child: number; infant: number }> = {};

  for (const tier of pricingTable.tiers) {
    const cellsByType: Partial<Record<TicketType, number>> = {};

    for (const cell of tier.cells) {
      if (!Number.isFinite(cell.unitPrice) || !Number.isInteger(cell.unitPrice)) {
        throw new Error(
          `unitPrice는 정수여야 합니다. (paxTier ${tier.paxTier}, ${cell.ticketType})`
        );
      }
      if (cell.unitPrice < 0) {
        throw new Error(
          `unitPrice는 0 이상이어야 합니다. (paxTier ${tier.paxTier}, ${cell.ticketType})`
        );
      }
      cellsByType[cell.ticketType] = cell.unitPrice;
    }

    const missing = EXPECTED_TICKET_TYPES.filter((type) => cellsByType[type] == null);
    if (missing.length > 0) {
      throw new Error(
        `paxTier ${tier.paxTier}에 누락된 ticketType: ${missing.join(", ")}`
      );
    }

    tiers[tier.paxTier] = {
      adult: cellsByType.adult as number,
      child: cellsByType.child as number,
      infant: cellsByType.infant as number,
    };
  }

  return { maxPax, tiers };
}
