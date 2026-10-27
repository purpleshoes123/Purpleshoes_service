const COUPON_PREFIX = "coupon";

export function stateKey(customerId: string): string {
  return `${COUPON_PREFIX}:state:customer:${customerId}`;
}

export function idemKey(eventType: string, eventId: string): string {
  return `${COUPON_PREFIX}:idem:${eventType}:${eventId}`;
}

export function revokedCustomerKey(customerId: string): string {
  return `${COUPON_PREFIX}:revoked:customer:${customerId}`;
}

export function revokedCodeKey(): string {
  return `${COUPON_PREFIX}:revoked:code`;
}

export function lockKey(lockName: string, customerId: string): string {
  return `${COUPON_PREFIX}:lock:${lockName}:${customerId}`;
}

export function shareIntentKey(shareEventId: string): string {
  return `${COUPON_PREFIX}:share:intent:${shareEventId}`;
}
