import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
export const REVIEW_SHOP = 'eafxf4-t9.myshopify.com';
export const REVIEW_TAG = 'PURPLESHOES_APP_REVIEW_ONLY';
export const REVIEW_TOKEN_PREFIX = 'psr1_';
const SESSION_SECONDS = 8 * 60 * 60;

export type ReviewConfig = {
  customerId: string;
  username: string;
  passwordHash: string;
  revision: string;
  expiresAt: number;
};
export interface ReviewStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, seconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  increment(key: string, seconds: number): Promise<number>;
}
export class ReviewAuthError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function unavailable(): never {
  throw new ReviewAuthError(503, 'REVIEW_UNAVAILABLE', 'Review sign-in is unavailable.');
}
function denied(): never {
  throw new ReviewAuthError(401, 'AUTH_LOGIN_REQUIRED', 'Review credentials are invalid or expired.');
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function rawConfig(): Record<string, unknown> | null {
  try {
    const value = JSON.parse(process.env.APP_REVIEW_AUTH_CONFIG || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
// A reserved review identity must never fall through to the legacy raw-GID auth.
export function reservedReviewCustomerId(): string | null {
  // Keep this non-secret reservation even when the secret config is disabled/removed.
  const id = process.env.APP_REVIEW_CUSTOMER_ID;
  return typeof id === 'string' && /^gid:\/\/shopify\/Customer\/\d+$/.test(id) ? id : null;
}
export function getReviewConfig(now = Date.now()): ReviewConfig {
  const raw = rawConfig();
  if (!raw || raw.enabled !== true || !reservedReviewCustomerId() ||
    typeof raw.username !== 'string' || !/^[a-zA-Z0-9@._+-]{3,128}$/.test(raw.username) ||
    typeof raw.passwordHash !== 'string' || !/^scrypt:32768:8:1:[a-f0-9]{64}:[a-f0-9]{128}$/.test(raw.passwordHash) ||
    typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision) ||
    typeof raw.expiresAt !== 'string') return unavailable();
  const expiresAt = Date.parse(raw.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return unavailable();
  return { customerId: reservedReviewCustomerId()!, username: raw.username.toLowerCase(),
    passwordHash: raw.passwordHash, revision: raw.revision, expiresAt };
}
function fingerprint(config: ReviewConfig) { return digest(JSON.stringify(config)); }
function tokenKey(token: string) { return `app-review:session:${digest(token)}`; }
export function reviewBearer(request: Request): string | null {
  const match = /^Bearer (psr1_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get('Authorization') || '');
  return match?.[1] || null;
}
export function hasReviewBearer(request: Request): boolean {
  return /^Bearer psr1_/i.test(request.headers.get('Authorization') || '');
}
export async function hashReviewPassword(password: string): Promise<string> {
  if (password.length < 20 || password.length > 256) throw new Error('Use a unique password of 20–256 characters.');
  const salt = randomBytes(32).toString('hex');
  const key = await deriveKey(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  return `scrypt:32768:8:1:${salt}:${key.toString('hex')}`;
}
export async function createReviewSession(
  username: string, password: string, config: ReviewConfig, store: ReviewStore,
  checkDedicatedAccount: (customerId: string) => Promise<void>, now = Date.now(),
) {
  // Shared, atomic limit: no spoofable forwarding header and no memory fallback.
  if (await store.increment('app-review:login-attempts', 60) > 12) {
    throw new ReviewAuthError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.');
  }
  if (username.length > 128 || password.length < 20 || password.length > 256) denied();
  const parts = config.passwordHash.split(':');
  const key = await deriveKey(password, parts[4], 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }) as Buffer;
  const passwordMatches = timingSafeEqual(key, Buffer.from(parts[5], 'hex'));
  const usernameMatches = timingSafeEqual(Buffer.from(digest(username.toLowerCase())), Buffer.from(digest(config.username)));
  if (!passwordMatches || !usernameMatches || config.expiresAt <= now) denied();
  await checkDedicatedAccount(config.customerId);
  const ttl = Math.min(SESSION_SECONDS, Math.floor((config.expiresAt - now) / 1000));
  if (ttl <= 0) denied();
  const token = `${REVIEW_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const expiresAt = now + ttl * 1000;
  await store.set(tokenKey(token), JSON.stringify({ fingerprint: fingerprint(config), expiresAt }), ttl);
  return { accessToken: token, expiresAt, provider: 'reviewer' as const };
}
export async function verifyReviewSession(request: Request, config: ReviewConfig, store: ReviewStore, now = Date.now()) {
  const token = reviewBearer(request);
  if (!token || config.expiresAt <= now) return denied();
  const raw = await store.get(tokenKey(token));
  if (!raw) return denied();
  let session: { fingerprint?: unknown; expiresAt?: unknown };
  try { session = JSON.parse(raw); } catch { return denied(); }
  if (!session || session.fingerprint !== fingerprint(config) || typeof session.expiresAt !== 'number' || session.expiresAt <= now) return denied();
  return { customerId: config.customerId, expiresAt: session.expiresAt };
}
export async function revokeReviewSession(request: Request, store: ReviewStore) {
  const token = reviewBearer(request);
  if (token) await store.delete(tokenKey(token));
}
