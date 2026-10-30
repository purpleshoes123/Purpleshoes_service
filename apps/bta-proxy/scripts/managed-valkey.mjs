// The secret supplies only AUTH; the deployment configuration pins the destination.
export function valkeyUrlWithSecret(redisUrl, secretString) {
  try {
    const url = new URL(redisUrl);
    const secret = JSON.parse(secretString);
    if (
      url.protocol !== "rediss:" ||
      !/\.cache\.amazonaws\.com$/i.test(url.hostname) ||
      (url.port && url.port !== "6379") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/", "/0"].includes(url.pathname) ||
      typeof secret?.authToken !== "string" ||
      !secret.authToken ||
      Object.keys(secret).some((key) => key !== "authToken")
    ) {
      throw new Error();
    }
    url.password = encodeURIComponent(secret.authToken);
    return url.toString();
  } catch {
    throw new Error("Managed Valkey configuration is invalid");
  }
}

// Load once at startup. A manual token change requires a controlled fleet restart.
export async function resolveManagedValkey({ redisUrl, secretId, readSecret, probe }) {
  if (!secretId) {
    return redisUrl;
  }
  try {
    const secret = await readSecret(secretId);
    const url = valkeyUrlWithSecret(redisUrl, secret.SecretString);
    await probe(url);
    return url;
  } catch {
    // SDK/Redis errors may contain credentials or endpoint details.
    throw new Error("Managed Valkey startup verification failed");
  }
}
