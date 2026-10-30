export type RebuildRunMeta = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  mode?: "upsert" | "replace";
  ordersFrom?: string;
  ordersTo?: string;
  result?: {
    scannedOrders: number;
    scannedLineItems: number;
    matchedTravelLineItems: number;
    upsertedBookings: number;
    deletedBookings: number;
  };
};

const KEY_PREFIX = "admin:rebuild:lastRun";

function buildKey(shop: string): string {
  return `${KEY_PREFIX}:${shop}`;
}

export async function setLastRebuildRun(
  redisClient: any,
  shop: string,
  meta: RebuildRunMeta,
): Promise<void> {
  const key = buildKey(shop);
  await redisClient.set(key, JSON.stringify(meta));
}

export async function getLastRebuildRun(
  redisClient: any,
  shop: string,
): Promise<RebuildRunMeta | null> {
  const key = buildKey(shop);
  const payload = await redisClient.get(key);
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload) as RebuildRunMeta;
  } catch {
    return null;
  }
}
