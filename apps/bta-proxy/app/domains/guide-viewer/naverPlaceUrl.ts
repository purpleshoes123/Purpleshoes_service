/** Only accept public NAVER place/share links, never coordinates or arbitrary redirects. */
export function isNaverPlaceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      return false;
    }
    if (url.hostname === "naver.me") {
      return /^\/[A-Za-z0-9]+\/?$/.test(url.pathname);
    }
    if (url.hostname === "map.naver.com") {
      return /\/place\/\d+(?:\/|$)/.test(url.pathname);
    }
    return (
      ["m.place.naver.com", "pcmap.place.naver.com"].includes(url.hostname) &&
      /^\/[a-z]+\/\d+(?:\/|$)/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
