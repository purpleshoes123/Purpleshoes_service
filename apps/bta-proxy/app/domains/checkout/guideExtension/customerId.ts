/**
 * Extract and normalize customer id from App Proxy request.
 * Priority: logged_in_customer_id -> customer_id -> customerId.
 */
export function extractCustomerIdFromProxyRequest(request: Request): string | null {
  const url = new URL(request.url);
  const raw =
    url.searchParams.get("logged_in_customer_id") ||
    url.searchParams.get("customer_id") ||
    url.searchParams.get("customerId");

  if (!raw) {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("gid://")) {
    return trimmed;
  }

  if (/^\d+$/.test(trimmed)) {
    return `gid://shopify/Customer/${trimmed}`;
  }

  return null;
}
