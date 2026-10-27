import type { CartDiscountAdapter, CartDiscountAdapterContext, SetCodesResult } from "./adapter";
import { getMockCartCodes, setMockCartCodes } from "./mockCartStore";

export class MockCartDiscountAdapter implements CartDiscountAdapter {
  async getAppliedCodes(ctx: CartDiscountAdapterContext): Promise<string[]> {
    return Array.from(getMockCartCodes(ctx.cartId));
  }

  async setAppliedCodes(
    ctx: CartDiscountAdapterContext,
    codes: string[]
  ): Promise<SetCodesResult> {
    setMockCartCodes(ctx.cartId, codes);
    return {
      appliedCodes: [...codes],
      invalidCodes: [],
      warnings: [],
    };
  }
}
