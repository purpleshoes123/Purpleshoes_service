export type CartDiscountAdapterContext = {
  cartId: string;
  shop?: string | null;
};

export type SetCodesResult = {
  appliedCodes: string[];
  invalidCodes: string[];
  warnings: string[];
};

export interface CartDiscountAdapter {
  getAppliedCodes(ctx: CartDiscountAdapterContext): Promise<string[]>;
  setAppliedCodes(ctx: CartDiscountAdapterContext, codes: string[]): Promise<SetCodesResult>;
}
