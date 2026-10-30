type ReadinessDependencies = {
  database: () => Promise<unknown>;
  sharedState: () => Promise<boolean>;
};

// A dependency check, not a data-migration/failover verification. Never return
// exception messages: drivers can include credentials or connection addresses.
export async function checkReadiness(
  dependencies: ReadinessDependencies,
  timeoutMs = 2000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const checks = Promise.all([
      Promise.resolve().then(dependencies.database),
      Promise.resolve().then(dependencies.sharedState),
    ]).then(([, sharedState]) => sharedState === true);
    return await Promise.race([
      checks,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
