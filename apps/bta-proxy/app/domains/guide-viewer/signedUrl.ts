import { createHmac, timingSafeEqual } from "crypto";

function signingSecret(): string {
  const secret = process.env.GKV_SIGNED_URL_SECRET;
  if (!secret?.trim() || secret.trim() === "gkv-dev-secret") {
    throw new Error("GKV signing secret is not securely configured");
  }
  return secret;
}

function getTtlSec(): number {
  const raw = process.env.GKV_SIGNED_URL_TTL_SEC || "600";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 600;
  }
  return parsed;
}

export function buildGkvSignedUrl(params: { assetId: string; customerId: string; s3Key: string }): {
  url: string;
  expiresAt: string;
  ttlSec: number;
} {
  const ttlSec = getTtlSec();
  const expiresAtMs = Date.now() + ttlSec * 1000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const baseUrl = process.env.GKV_SIGNED_URL_BASE_URL || "https://example-cdn.local";
  const secret = signingSecret();

  const payload = `${params.assetId}:${params.customerId}:${params.s3Key}:${Math.floor(expiresAtMs / 1000)}`;
  const sig = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const encodedKey = encodeURIComponent(params.s3Key);
  const encodedCustomerId = encodeURIComponent(params.customerId);
  const encodedAssetId = encodeURIComponent(params.assetId);
  const url =
    `${baseUrl}/gkv/${encodedKey}` +
    `?exp=${Math.floor(expiresAtMs / 1000)}&sig=${sig}&aid=${encodedAssetId}&cid=${encodedCustomerId}`;

  return { url, expiresAt, ttlSec };
}

export function verifyGkvSignedUrl(params: {
  assetId: string;
  customerId: string;
  s3Key: string;
  exp: number;
  sig: string;
}): boolean {
  let secret: string;
  try {
    secret = signingSecret();
  } catch {
    return false;
  }
  const payload = `${params.assetId}:${params.customerId}:${params.s3Key}:${params.exp}`;
  const computed = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  try {
    return timingSafeEqual(Buffer.from(params.sig, "hex"), Buffer.from(computed, "hex"));
  } catch {
    return false;
  }
}
