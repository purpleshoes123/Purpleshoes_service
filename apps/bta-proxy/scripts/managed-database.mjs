// Only replace the credential: a secret cannot redirect the database connection.
export function databaseUrlWithSecret(databaseUrl, secretString) {
  try {
    const url = new URL(databaseUrl);
    const secret = JSON.parse(secretString);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      !url.username ||
      typeof secret.username !== "string" ||
      typeof secret.password !== "string" ||
      !secret.password ||
      decodeURIComponent(url.username) !== secret.username ||
      (secret.host && secret.host !== url.hostname) ||
      (secret.port && String(secret.port) !== (url.port || "5432")) ||
      (secret.dbname && secret.dbname !== decodeURIComponent(url.pathname.slice(1)))
    ) {
      throw new Error();
    }
    url.password = encodeURIComponent(secret.password);
    return url.toString();
  } catch {
    // Never expose the URL, password, or the JSON parser's secret excerpt.
    throw new Error("Managed database secret does not match the configured database");
  }
}

/** @param {{ databaseUrl?: string, secretId?: string, readSecret: Function, probe: Function }} options */
export function createDatabaseCredentialResolver({ databaseUrl, secretId, readSecret, probe }) {
  let currentUrl;
  let pending;
  return async function refresh() {
    if (!secretId) {
      return { url: databaseUrl, changed: false };
    }
    if (pending) {
      return pending;
    }
    pending = (async () => {
      const secret = await readSecret(secretId);
      const nextUrl = databaseUrlWithSecret(databaseUrl, secret.SecretString);
      const changed = currentUrl !== undefined && nextUrl !== currentUrl;
      if (nextUrl !== currentUrl) {
        await probe(nextUrl);
      }
      currentUrl = nextUrl;
      return { url: nextUrl, changed };
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
