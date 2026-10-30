export function pdfContentPath(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["cdn.kpurpleshoes.com", "bta-proxy.kpurpleshoes.com"].includes(url.hostname) ||
    !url.pathname.startsWith("/gkv/") ||
    !["sig", "exp", "aid", "cid"].every((key) => url.searchParams.has(key))
  ) {
    throw new Error("Invalid guide link");
  }
  return url.pathname + url.search;
}
