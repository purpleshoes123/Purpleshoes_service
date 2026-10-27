const cartStore = new Map<string, Set<string>>();

export function getMockCartCodes(cartId: string): Set<string> {
  const existing = cartStore.get(cartId);
  if (existing) {
    return new Set(existing);
  }
  const fresh = new Set<string>();
  cartStore.set(cartId, fresh);
  return new Set(fresh);
}

export function setMockCartCodes(cartId: string, codes: string[]): void {
  cartStore.set(cartId, new Set(codes));
}

export function resetMockCartStore(): void {
  cartStore.clear();
}
