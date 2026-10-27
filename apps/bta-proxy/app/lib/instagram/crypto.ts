import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const CIPHER_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function resolveEncryptionSecret(): string {
  const explicit = (process.env.INSTAGRAM_TOKEN_ENCRYPTION_KEY || "").trim();
  if (explicit) return explicit;

  const fallback =
    (process.env.INSTAGRAM_APP_SECRET || "").trim() ||
    (process.env.SHOPIFY_API_SECRET || "").trim() ||
    (process.env.SHOPIFY_APP_SECRET || "").trim();

  if (!fallback) {
    throw new Error("Instagram token encryption secret is not configured");
  }

  return fallback;
}

function resolveEncryptionKey(): Buffer {
  return createHash("sha256").update(resolveEncryptionSecret(), "utf8").digest();
}

export function encryptInstagramToken(token: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, resolveEncryptionKey(), iv);

  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}.${authTag.toString("hex")}.${encrypted.toString("hex")}`;
}

export function decryptInstagramToken(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = Buffer.from(parts[2], "hex");

  const decipher = createDecipheriv(CIPHER_ALGORITHM, resolveEncryptionKey(), iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

export function maskTokenForLogs(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}
