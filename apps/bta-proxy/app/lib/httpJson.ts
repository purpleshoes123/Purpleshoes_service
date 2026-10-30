/** Preserve the existing JSON resource API contract during the router upgrade. */
export function json<T>(
  value: T,
  init: number | ResponseInit = {},
): Response & { json(): Promise<T> } {
  const options = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), { ...options, headers }) as Response & {
    json(): Promise<T>;
  };
}
