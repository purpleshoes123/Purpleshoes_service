type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return Boolean((error as any).retryable);
}

export async function withShopifyRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === attempts - 1) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Shopify retry failed");
}

export async function adminGraphqlWithRetry(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  query: string,
  variables: Record<string, unknown>,
  options: RetryOptions = {}
): Promise<any> {
  return await withShopifyRetry(async () => {
    const response = await admin.graphql(query, { variables });
    if (!response.ok) {
      const error = new Error(`Shopify Admin API request failed with status ${response.status}`);
      if (RETRYABLE_STATUS.has(response.status)) {
        (error as any).retryable = true;
      }
      throw error;
    }
    return await response.json();
  }, options);
}

export async function storefrontGraphqlWithRetry(
  fetcher: () => Promise<Response>,
  options: RetryOptions = {}
): Promise<any> {
  return await withShopifyRetry(async () => {
    const response = await fetcher();
    if (!response.ok) {
      const error = new Error(`Storefront API request failed: ${response.status}`);
      if (RETRYABLE_STATUS.has(response.status)) {
        (error as any).retryable = true;
      }
      throw error;
    }
    return await response.json();
  }, options);
}
