import { createHmac, timingSafeEqual } from "node:crypto";

const RECEIPT_TTL_MS = 10 * 60 * 1000;

function secret() {
  const value = process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_APP_SECRET;
  if (!value) throw new Error("Shopify app secret is missing");
  return value;
}

function signature(payload: string): Buffer {
  return createHmac("sha256", secret()).update(payload).digest();
}

export function createLeadReceipt(requestId: string, shopDomain: string): string {
  const payload = Buffer.from(JSON.stringify({
    requestId,
    shopDomain,
    expiresAt: Date.now() + RECEIPT_TTL_MS,
  })).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyLeadReceipt(receipt: string, shopDomain: string): string | null {
  if (typeof receipt !== "string" || receipt.length > 1024) return null;
  const [payload, provided, extra] = receipt.split(".");
  if (!payload || !provided || extra) return null;
  const expected = signature(payload);
  const providedBuffer = Buffer.from(provided, "base64url");
  if (providedBuffer.length !== expected.length ||
      !timingSafeEqual(providedBuffer, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed.shopDomain !== shopDomain ||
        typeof parsed.requestId !== "string" || !/^[a-z0-9_-]{5,100}$/i.test(parsed.requestId) ||
        typeof parsed.expiresAt !== "number" ||
        parsed.expiresAt < Date.now() ||
        parsed.expiresAt > Date.now() + RECEIPT_TTL_MS) return null;
    return parsed.requestId;
  } catch {
    return null;
  }
}
