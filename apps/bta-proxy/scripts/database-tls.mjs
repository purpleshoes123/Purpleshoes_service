import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// RDS native Prisma connections must validate both the certificate and host.
// Keep local/test PostgreSQL connections unchanged.
export function databaseUrlWithVerifiedTls(databaseUrl, caFile = process.env.DATABASE_TLS_CA_FILE,
  fileExists = existsSync) {
  if (!databaseUrl) return databaseUrl;
  let url;
  try { url = new URL(databaseUrl); } catch {
    throw new Error('Database URL is invalid');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/\.rds\.amazonaws\.com(?:\.cn)?$/i.test(url.hostname)) return databaseUrl;
  const certificate = caFile || fileURLToPath(new URL('../certs/rds-ap-northeast-2-rsa2048-g1.pem', import.meta.url));
  if (!fileExists(certificate)) throw new Error('RDS CA certificate is missing; refusing unverified TLS');
  // A host override must not bypass the RDS hostname identity check.
  if (url.searchParams.has('host') && url.searchParams.get('host') !== url.hostname) {
    throw new Error('RDS host override is not allowed');
  }
  url.searchParams.set('sslmode', 'require');
  url.searchParams.set('sslaccept', 'strict');
  url.searchParams.set('sslcert', certificate);
  return url.toString();
}
