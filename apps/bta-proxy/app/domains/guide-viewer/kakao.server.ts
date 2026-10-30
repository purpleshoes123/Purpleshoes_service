const KAKAO_BASE = "https://dapi.kakao.com";
const KAKAO_PLACE_WEB_BASE = "https://place.map.kakao.com";

function getKakaoApiKey(): string {
  const value = process.env.GKV_KAKAO_REST_API_KEY?.trim();
  if (!value) {
    throw new Error("GKV_KAKAO_REST_API_KEY가 설정되지 않았습니다.");
  }
  return value;
}

async function fetchKakao(path: string, query: Record<string, string>) {
  const url = new URL(path, KAKAO_BASE);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `KakaoAK ${getKakaoApiKey()}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Kakao API 요청 실패 (${response.status})`);
    }

    return (await response.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#([0-9]+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function findMetaContent(html: string, key: string, attr: "property" | "name"): string | null {
  const escapedKey = escapeRegExp(key);
  const patterns = [
    new RegExp(`<meta[^>]*${attr}=["']${escapedKey}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*${attr}=["']${escapedKey}["'][^>]*>`, "i"),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]);
    }
  }

  return null;
}

function parseCoordinatesFromStaticMapUrl(
  imageUrlRaw: string,
): { lat: number; lng: number } | null {
  try {
    const normalized = imageUrlRaw.startsWith("//") ? `https:${imageUrlRaw}` : imageUrlRaw;
    const imageUrl = new URL(normalized);
    const marker = imageUrl.searchParams.get("m");
    if (!marker) {
      return null;
    }
    const [lngRaw, latRaw] = marker.split(",");
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    return { lat, lng };
  } catch {
    return null;
  }
}

async function fetchPlaceFromWebPage(placeId: string) {
  const url = `${KAKAO_PLACE_WEB_BASE}/${encodeURIComponent(placeId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      return null;
    }

    const html = await response.text();
    const name = findMetaContent(html, "og:title", "property");
    const address = findMetaContent(html, "og:description", "property");
    const imageUrl = findMetaContent(html, "twitter:image", "name");
    const coords = imageUrl ? parseCoordinatesFromStaticMapUrl(imageUrl) : null;

    if (!name || !address || !coords) {
      return null;
    }

    return {
      placeId,
      name,
      address,
      lat: coords.lat,
      lng: coords.lng,
      phone: null,
      raw: {
        source: "place.map.kakao.com",
        imageUrl,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function toNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function geocodeAddress(address: string) {
  const json = await fetchKakao("/v2/local/search/address.json", { query: address });
  const documents = Array.isArray(json.documents) ? json.documents : [];
  const first = (documents[0] ?? {}) as Record<string, unknown>;

  const roadAddress = (first.road_address as Record<string, unknown> | undefined) ?? null;
  const addressObj = (first.address as Record<string, unknown> | undefined) ?? null;

  const lat = toNumber(roadAddress?.y ?? addressObj?.y ?? first.y);
  const lng = toNumber(roadAddress?.x ?? addressObj?.x ?? first.x);

  if (lat === null || lng === null) {
    throw new Error("주소 좌표를 찾지 못했습니다.");
  }

  return {
    address,
    lat,
    lng,
    raw: json,
  };
}

export async function fetchPlace(placeId: string) {
  const json = await fetchKakao("/v2/local/search/keyword.json", { query: placeId });
  const documents = Array.isArray(json.documents) ? json.documents : [];
  const exact = documents.find(
    (entry) => String((entry as Record<string, unknown>).id ?? "") === placeId,
  ) as Record<string, unknown> | undefined;
  const first = (exact ?? documents[0] ?? null) as Record<string, unknown> | null;

  if (first) {
    const lat = toNumber(first.y);
    const lng = toNumber(first.x);

    if (lat === null || lng === null) {
      throw new Error("장소 좌표를 찾지 못했습니다.");
    }

    return {
      placeId: String(first.id ?? placeId),
      name: String(first.place_name ?? ""),
      address: String(first.road_address_name ?? first.address_name ?? ""),
      lat,
      lng,
      phone: first.phone ? String(first.phone) : null,
      raw: json,
    };
  }

  const fallback = await fetchPlaceFromWebPage(placeId);
  if (fallback) {
    return fallback;
  }

  throw new Error("장소 정보를 찾지 못했습니다.");
}
