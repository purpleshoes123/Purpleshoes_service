import { normalizeCode } from "./normalize";

export function maskCouponCode(code: string | null | undefined): string | null {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  if (normalized.length <= 12) return `${normalized.slice(0, 4)}...`;
  return `${normalized.slice(0, 8)}...${normalized.slice(-4)}`;
}

export function maskCustomerId(customerId: string | number | null | undefined): string | null {
  if (customerId === null || customerId === undefined) return null;
  const raw = String(customerId).trim();
  if (!raw) return null;
  return raw.length <= 4 ? raw : `...${raw.slice(-4)}`;
}
