import { getTourCodeKind, getCouponKindFromCode } from "./codes";

export function validateCodes(codes: Set<string>): void {
  let tourCount = 0;

  for (const code of codes) {
    const tourKind = getTourCodeKind(code);
    if (tourKind) {
      tourCount += 1;
      continue;
    }

    const kind = getCouponKindFromCode(code);
    if (!kind) {
      throw new Error(`Unknown coupon code: ${code}`);
    }
  }

  if (tourCount > 1) {
    throw new Error("TOUR% codes must be mutually exclusive");
  }
}
