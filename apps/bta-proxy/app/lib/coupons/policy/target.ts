import { normalizeCode } from "../normalize";
import type { TourPercentCode } from "../types";

export type TargetContext = {
  tourPercentCode: TourPercentCode | null;
  wantsExtra10: boolean;
  containsExtension: boolean;
  extra10Code?: string | null;
  allowExtra10WithoutCode?: boolean;
};

export function computeTargetCodes(ctx: TargetContext): Set<string> {
  const codes = new Set<string>();

  if (ctx.tourPercentCode) {
    codes.add(ctx.tourPercentCode);
  }

  if (ctx.wantsExtra10 && !ctx.containsExtension) {
    const normalized = normalizeCode(ctx.extra10Code || null);
    if (normalized) {
      codes.add(normalized);
    } else if (ctx.allowExtra10WithoutCode) {
      codes.add("EXTRA10");
    }
  }

  return codes;
}
