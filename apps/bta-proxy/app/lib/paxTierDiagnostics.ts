import type { TierVariantTable, TicketType } from "./tierVariantPricingService";

export interface PaxTierDiagnosticsResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    maxPax: number;
    tiersFound: number[];
    missingTiers: number[];
    missingCells: Array<{ tier: number; ticketType: string }>;
  };
}

const ticketTypes: TicketType[] = ["Adult", "Child", "Infant"];

export function paxTierDiagnostics(params: {
  travelMaxPax: number;
  tierTable: TierVariantTable;
}): PaxTierDiagnosticsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxPax = Number.isFinite(params.travelMaxPax)
    ? Math.max(0, Math.trunc(params.travelMaxPax))
    : 0;

  if (maxPax <= 0) {
    errors.push("travel.max_pax 값이 유효하지 않습니다.");
  }

  const tiersFound = Object.keys(params.tierTable.byTier)
    .map((key) => Number(key))
    .filter((tier) => Number.isFinite(tier) && tier > 0)
    .sort((a, b) => a - b);

  const missingTiers: number[] = [];
  for (let tier = 1; tier <= maxPax; tier += 1) {
    if (!params.tierTable.byTier[tier]) {
      missingTiers.push(tier);
    }
  }
  if (missingTiers.length > 0) {
    errors.push(`Pax Tier 누락: ${missingTiers.join(", ")} (1..${maxPax} 연속)`);
  }

  const missingCells: Array<{ tier: number; ticketType: string }> = [];
  for (let tier = 1; tier <= maxPax; tier += 1) {
    const row = params.tierTable.byTier[tier];
    if (!row) {
      continue;
    }
    for (const type of ticketTypes) {
      const cell = row[type];
      if (!cell) {
        missingCells.push({ tier, ticketType: type });
        errors.push(`Pax Tier ${tier}의 ${type} variant 누락`);
        continue;
      }
      if (typeof cell.unitPrice !== "number" || !Number.isFinite(cell.unitPrice)) {
        errors.push(`Pax Tier ${tier}의 ${type} 가격이 유효하지 않습니다.`);
        continue;
      }
      if (cell.unitPrice < 0) {
        errors.push(`Pax Tier ${tier}의 ${type} 가격이 음수입니다.`);
        continue;
      }
      if (cell.unitPrice === 0) {
        warnings.push(`Pax Tier ${tier}의 ${type} 가격이 0원입니다.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      maxPax,
      tiersFound,
      missingTiers,
      missingCells,
    },
  };
}
