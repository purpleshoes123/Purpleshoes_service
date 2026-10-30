import { diffSets } from "./diff";
import type { CartDiscountAdapter } from "./adapter";
import { normalizeCode } from "../normalize";

export type ApplySyncParams = {
  cartId: string;
  shop?: string | null;
  adapter: CartDiscountAdapter;
  targetCodes: Set<string>;
  containsExtension: boolean;
  onInvalidCode?: (code: string) => Promise<void> | void;
};

export type ApplySyncResult = {
  appliedCodes: string[];
  removedCodes: string[];
  addedCodes: string[];
  invalidCodes: string[];
  warnings: string[];
};

function normalizeCodes(codes: string[]): Set<string> {
  const set = new Set<string>();
  for (const code of codes) {
    const normalized = normalizeCode(code);
    if (normalized) {
      set.add(normalized);
    }
  }
  return set;
}

function sortCodes(codes: Iterable<string>): string[] {
  return Array.from(codes).sort();
}

export async function applyCouponSync(params: ApplySyncParams): Promise<ApplySyncResult> {
  const warnings: string[] = [];
  const invalidCodes: string[] = [];

  const currentRaw = await params.adapter.getAppliedCodes({
    cartId: params.cartId,
    shop: params.shop,
  });
  let currentCodes = normalizeCodes(currentRaw);

  const { toRemove, toAdd } = diffSets(currentCodes, params.targetCodes);

  // Remove first
  if (toRemove.length > 0) {
    const nextCodes = sortCodes(
      Array.from(currentCodes).filter((code) => !toRemove.includes(code)),
    );
    const result = await params.adapter.setAppliedCodes(
      { cartId: params.cartId, shop: params.shop },
      nextCodes,
    );
    if (result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
    if (result.invalidCodes.length > 0) {
      invalidCodes.push(...result.invalidCodes);
    }
    currentCodes = normalizeCodes(result.appliedCodes);
  }

  // Add later
  if (toAdd.length > 0) {
    const nextCodes = sortCodes(new Set([...currentCodes, ...toAdd]));
    const result = await params.adapter.setAppliedCodes(
      { cartId: params.cartId, shop: params.shop },
      nextCodes,
    );
    if (result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
    if (result.invalidCodes.length > 0) {
      invalidCodes.push(...result.invalidCodes);
    }
    currentCodes = normalizeCodes(result.appliedCodes);
  }

  const missingAdds = toAdd.filter((code) => !currentCodes.has(code));
  if (missingAdds.length > 0) {
    for (const code of missingAdds) {
      if (!invalidCodes.includes(code)) {
        invalidCodes.push(code);
      }
    }
  }

  for (const code of invalidCodes) {
    if (params.onInvalidCode) {
      await params.onInvalidCode(code);
    }
  }

  return {
    appliedCodes: sortCodes(currentCodes),
    removedCodes: toRemove.sort(),
    addedCodes: toAdd.sort(),
    invalidCodes: Array.from(new Set(invalidCodes)).sort(),
    warnings,
  };
}
