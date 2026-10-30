import { createHmac, timingSafeEqual } from "crypto";

export function verifyGkvWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.GKV_WEBHOOK_SECRET || "";
  if (!secret || !signature) {
    return false;
  }
  const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const provided = signature.trim().toLowerCase();
  if (provided.length !== computed.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(computed, "hex"));
}
