export function normalizeCustomerId(
  input: string | number | null | undefined
): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  if (raw.startsWith("gid://")) {
    return raw;
  }

  if (/^\d+$/.test(raw)) {
    return `gid://shopify/Customer/${raw}`;
  }

  return null;
}

export function extractCustomerIdNumeric(
  customerId: string | null | undefined
): string | null {
  if (!customerId) return null;
  if (customerId.startsWith("gid://")) {
    const parts = customerId.split("/");
    return parts[parts.length - 1] || null;
  }
  if (/^\d+$/.test(customerId)) return customerId;
  return null;
}
