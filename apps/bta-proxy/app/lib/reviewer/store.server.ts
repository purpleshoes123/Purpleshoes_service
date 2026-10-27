import Redis from 'ioredis';
import { unavailable, type ReviewStore } from './auth.server';

let client: Redis | undefined;
export function reviewStore(): ReviewStore {
  if (!process.env.REDIS_URL) return unavailable();
  if (!client) {
    client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 3000, connectTimeout: 3000, enableOfflineQueue: false });
    // Never log a URL, credentials, command arguments or raw Redis error.
    client.on('error', () => {});
  }
  const redis = client;
  return {
    get: key => redis.get(key),
    set: async (key, value, ttl) => { await redis.set(key, value, 'EX', ttl); },
    delete: async key => { await redis.del(key); },
    increment: async (key, ttl) => Number(await redis.eval(
      'local n=redis.call("INCR",KEYS[1]); if n==1 then redis.call("EXPIRE",KEYS[1],ARGV[1]) end; return n', 1, key, ttl)),
  };
}
