export function withEmbeddedSearch(path: string, search: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (!query) {
    return path;
  }

  const hashIndex = path.indexOf("#");
  const pathWithoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const queryIndex = pathWithoutHash.indexOf("?");
  const basePath = queryIndex >= 0 ? pathWithoutHash.slice(0, queryIndex) : pathWithoutHash;
  const pathQuery = queryIndex >= 0 ? pathWithoutHash.slice(queryIndex + 1) : "";

  const merged = new URLSearchParams(pathQuery);
  const pathQueryKeys = new Set(merged.keys());
  const currentParams = new URLSearchParams(query);

  currentParams.forEach((value, key) => {
    // Bootstrap credentials expire; subsequent requests use fresh App Bridge tokens.
    if (["id_token", "hmac", "session", "timestamp", "shopify-reload"].includes(key)) {
      return;
    }
    if (!pathQueryKeys.has(key)) {
      merged.append(key, value);
    }
  });

  const mergedQuery = merged.toString();
  return `${basePath}${mergedQuery ? `?${mergedQuery}` : ""}${hash}`;
}

const EMBEDDED_QUERY_KEYS = ["shop", "host", "embedded"] as const;

export function getEmbeddedSearchEntries(search: string): Array<{ name: string; value: string }> {
  const params = new URLSearchParams(search);

  return EMBEDDED_QUERY_KEYS.map((name) => ({
    name,
    value: params.get(name) ?? "",
  })).filter((entry) => entry.value);
}
