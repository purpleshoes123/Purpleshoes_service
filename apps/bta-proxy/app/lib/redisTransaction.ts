type RedisMulti = {
  exec: () => Promise<Array<[Error | null, unknown]> | null>;
};

type RedisClientWithMulti = {
  multi: () => RedisMulti;
};

export async function runRedisTransaction<T>(
  client: RedisClientWithMulti,
  build: (tx: RedisMulti) => T | Promise<T>,
): Promise<T> {
  const tx = client.multi();
  const result = await build(tx);
  let execResult;
  try {
    execResult = await tx.exec();
  } catch {
    throw new Error("Redis transaction failed");
  }
  // EXEC can succeed while an individual command fails (for example WRONGTYPE).
  // Redis does not roll back the other commands, so never acknowledge this as
  // a successful booking change. Recovery must reconcile any partial effects.
  if (!execResult || execResult.some(([error]) => error !== null)) {
    throw new Error("Redis transaction failed");
  }
  return result;
}
