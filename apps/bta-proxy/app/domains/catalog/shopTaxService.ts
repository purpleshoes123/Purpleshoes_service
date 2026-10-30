/**
 * Shopify Shop tax settings resolver (rate + taxesIncluded).
 * Uses Admin REST API with offline session token.
 */

import { loadOfflineSession, normalizeShopDomain } from "../../lib/shopifySession";

export interface ShopTaxSettings {
  rate: number;
  taxesIncluded: boolean;
}

interface CachedEntry {
  value: ShopTaxSettings;
  expiresAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedEntry>();

function getCached(shop: string): ShopTaxSettings | null {
  const entry = cache.get(shop);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cache.delete(shop);
    return null;
  }
  return entry.value;
}

function setCached(shop: string, value: ShopTaxSettings): void {
  cache.set(shop, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function parseRate(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string") {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeRate(rate: number): number {
  if (rate < 0) {
    return 0;
  }
  if (rate > 1) {
    return rate / 100;
  }
  return rate;
}

export async function getShopTaxSettings(shop: string): Promise<ShopTaxSettings | null> {
  const normalizedShop = normalizeShopDomain(shop);
  const cached = getCached(normalizedShop);
  if (cached) {
    return cached;
  }

  const session = await loadOfflineSession(normalizedShop, {
    source: "shopTaxService",
  });
  if (!session || !session.accessToken) {
    return null;
  }

  const apiVersionString = "2025-01";
  const adminShopDomain = session.shop || normalizedShop;
  const baseUrl = `https://${adminShopDomain}/admin/api/${apiVersionString}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": session.accessToken,
  };

  try {
    const shopResponse = await fetch(`${baseUrl}/shop.json`, { headers });
    if (!shopResponse.ok) {
      return null;
    }

    const shopJson = await shopResponse.json();
    const shopData = shopJson?.shop;
    if (!shopData) {
      return null;
    }

    const countryCode = shopData.country_code || shopData.countryCode || shopData.country;
    const provinceCode = shopData.province_code || shopData.provinceCode || shopData.province;
    const taxesIncluded = Boolean(shopData.taxes_included ?? shopData.taxesIncluded);

    if (!countryCode) {
      return null;
    }

    const countriesResponse = await fetch(`${baseUrl}/countries.json`, {
      headers,
    });
    if (!countriesResponse.ok) {
      return null;
    }

    const countriesJson = await countriesResponse.json();
    const countries = Array.isArray(countriesJson?.countries) ? countriesJson.countries : [];

    const country = countries.find(
      (entry: any) =>
        entry?.code === countryCode ||
        entry?.iso_code === countryCode ||
        entry?.country_code === countryCode ||
        entry?.name === countryCode,
    );

    if (!country) {
      return null;
    }

    const countryRate =
      parseRate(country?.tax_percentage) ??
      parseRate(country?.taxPercentage) ??
      parseRate(country?.tax);

    let rate = countryRate;

    if (provinceCode && Array.isArray(country?.provinces)) {
      const province = country.provinces.find(
        (entry: any) => entry?.code === provinceCode || entry?.name === provinceCode,
      );
      const provinceRate =
        parseRate(province?.tax_percentage) ??
        parseRate(province?.taxPercentage) ??
        parseRate(province?.tax);
      if (provinceRate !== null) {
        rate = provinceRate;
      }
    }

    if (rate === null) {
      return null;
    }

    const settings = {
      rate: normalizeRate(rate),
      taxesIncluded,
    };
    setCached(normalizedShop, settings);
    return settings;
  } catch {
    return null;
  }
}
