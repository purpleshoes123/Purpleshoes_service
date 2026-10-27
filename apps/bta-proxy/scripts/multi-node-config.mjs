// This is a configuration gate, not a connectivity or migration test.
// Enable only on the new fleet after shared-state migration has been verified.
export function assertMultiNodeConfiguration(env) {
  const mode = env.DEPLOYMENT_MODE?.trim();
  if (!mode || mode === 'single-node') return;
  if (mode !== 'multi-node') throw new Error('Unsupported DEPLOYMENT_MODE');

  const problems = [];
  if (env.TRUSTED_PROXY_MODE !== 'cloudfront-alb') problems.push('TRUSTED_PROXY_MODE must identify the verified cloudfront-alb path');
  if (env.BOOKING_STORE_TYPE?.trim() !== 'redis') problems.push('BOOKING_STORE_TYPE must be redis');
  let redis;
  try { redis = new URL(env.REDIS_URL); } catch { /* Report no credential values. */ }
  const redisSecret = env.REDIS_SECRET_ARN?.trim();
  const hasManagedRedisSecret = /^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/.test(redisSecret || '');
  if (redisSecret && !hasManagedRedisSecret) problems.push('REDIS_SECRET_ARN must identify the managed Valkey credential');
  if (!redis || redis.protocol !== 'rediss:' ||
      !/\.cache\.amazonaws\.com$/i.test(redis.hostname) ||
      (!redis.password && !hasManagedRedisSecret) || redis.search || redis.hash) {
    problems.push('REDIS_URL must use an authenticated TLS ElastiCache endpoint without query overrides');
  }
  let database;
  try { database = new URL(env.DATABASE_URL); } catch { /* Report no credential values. */ }
  if (!database || !['postgres:', 'postgresql:'].includes(database.protocol) ||
      !/\.rds\.amazonaws\.com$/i.test(database.hostname)) {
    problems.push('DATABASE_URL must identify the shared RDS database');
  }
  if (!/^arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/.test(env.DATABASE_SECRET_ARN || '')) {
    problems.push('DATABASE_SECRET_ARN must identify the managed database credential');
  }
  // A verified source-manifest SHA-256 also identifies dirty-worktree releases exactly.
  // Never label such a release with its older base Git commit alone.
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(env.RELEASE_SHA || '')) problems.push('RELEASE_SHA must identify an immutable Git revision or source-manifest SHA-256');
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') problems.push('Global TLS certificate verification must not be disabled');
  if (problems.length) throw new Error(`Multi-node configuration rejected: ${problems.join('; ')}`);
}
