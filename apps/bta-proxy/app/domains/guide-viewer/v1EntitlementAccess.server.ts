import prisma from "~/db.server.ts";
import { getCustomerEntitlements } from "~/domains/checkout/guideExtension/customerMetafields";
import { getAdminApiClient } from "~/lib/shopifyAdmin";
import { normalizeShopDomain } from "~/lib/shopifySession";
import { hasReviewBearer, REVIEW_SHOP } from "~/domains/reviews/reviewer/auth.server.ts";

export type GuideEntitlementType = "PDF" | "VIDEO" | "BUNDLE" | "SHARED";

export type GuideExtensionEntitlements = {
  PDF: string | null;
  VIDEO: string | null;
  BUNDLE: string | null;
};

export const VIRTUAL_GUIDE_IDS: Record<Exclude<GuideEntitlementType, "SHARED">, string> = {
  PDF: "gkv_virtual_pdf",
  VIDEO: "gkv_virtual_video",
  BUNDLE: "gkv_virtual_bundle",
};

export const VIRTUAL_GUIDE_TITLES: Record<Exclude<GuideEntitlementType, "SHARED">, string> = {
  PDF: "Guide PDF",
  VIDEO: "Guide Video",
  BUNDLE: "Guide Bundle",
};

const EMPTY_ENTITLEMENTS: GuideExtensionEntitlements = {
  PDF: null,
  VIDEO: null,
  BUNDLE: null,
};

function normalizeShopCandidate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeShopDomain(raw);
  if (!normalized) {
    return null;
  }
  if (normalized.includes(".")) {
    return normalized;
  }
  return `${normalized}.myshopify.com`;
}

function parseActiveIso(raw: string | null, now: Date): string | null {
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  if (parsed.getTime() <= now.getTime()) {
    return null;
  }
  return parsed.toISOString();
}

function pickLatestIso(values: Array<string | null>): string | null {
  let latest: string | null = null;
  for (const value of values) {
    if (!value) {
      continue;
    }
    if (!latest) {
      latest = value;
      continue;
    }
    if (new Date(value).getTime() > new Date(latest).getTime()) {
      latest = value;
    }
  }
  return latest;
}

async function resolveShopFromSession(): Promise<string | null> {
  const sessions = await prisma.session.findMany({
    select: { shop: true, isOnline: true },
    distinct: ["shop"],
    orderBy: [{ shop: "asc" }],
  });
  if (sessions.length === 0) {
    return null;
  }

  const offline = sessions.find((session) => session.isOnline === false);
  return normalizeShopCandidate(offline?.shop || sessions[0]?.shop || null);
}

export async function resolveV1Shop(request: Request): Promise<string | null> {
  if (hasReviewBearer(request)) {
    return REVIEW_SHOP;
  }
  const url = new URL(request.url);
  const shopFromQuery = normalizeShopCandidate(url.searchParams.get("shop"));
  if (shopFromQuery) {
    return shopFromQuery;
  }

  const shopFromHeader = normalizeShopCandidate(
    request.headers.get("X-Shopify-Shop-Domain") || request.headers.get("X-Shop-Domain"),
  );
  if (shopFromHeader) {
    return shopFromHeader;
  }

  const shopFromEnv = normalizeShopCandidate(process.env.GKV_DEFAULT_SHOP);
  if (shopFromEnv) {
    return shopFromEnv;
  }

  return resolveShopFromSession();
}

export async function loadGuideExtensionEntitlements(
  request: Request,
  customerId: string,
): Promise<GuideExtensionEntitlements | null> {
  const shop = await resolveV1Shop(request);
  if (!shop) {
    return null;
  }

  const admin = await getAdminApiClient(shop);
  if (!admin) {
    return null;
  }

  try {
    const entitlements = await getCustomerEntitlements(admin, customerId);
    return {
      PDF: entitlements.PDF ?? null,
      VIDEO: entitlements.VIDEO ?? null,
      BUNDLE: entitlements.BUNDLE ?? null,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        message: "Failed to load Guide Extension entitlements for v1 API",
        shop,
        customerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

export function resolveEntitlementExpiry(
  type: GuideEntitlementType,
  entitlements: GuideExtensionEntitlements | null,
  now: Date,
): string | null {
  const normalized = entitlements || EMPTY_ENTITLEMENTS;
  const pdfExpiry = parseActiveIso(normalized.PDF, now);
  const videoExpiry = parseActiveIso(normalized.VIDEO, now);
  const bundleExpiry = parseActiveIso(normalized.BUNDLE, now);

  if (type === "PDF") {
    return pickLatestIso([pdfExpiry, bundleExpiry]);
  }
  if (type === "VIDEO") {
    return pickLatestIso([videoExpiry, bundleExpiry]);
  }
  if (type === "SHARED") {
    return pickLatestIso([pdfExpiry, videoExpiry, bundleExpiry]);
  }
  return bundleExpiry;
}

export function canAccessGuideType(
  type: GuideEntitlementType,
  entitlements: GuideExtensionEntitlements | null,
  now: Date,
): boolean {
  return Boolean(resolveEntitlementExpiry(type, entitlements, now));
}

export function canAccessAssetKind(
  kind: string,
  entitlements: GuideExtensionEntitlements | null,
  now: Date,
): boolean {
  if (kind === "PDF") {
    return canAccessGuideType("PDF", entitlements, now);
  }
  if (kind === "VIDEO") {
    return canAccessGuideType("VIDEO", entitlements, now);
  }
  return false;
}

export function toGuideEntitlementType(rawType: string): GuideEntitlementType | null {
  if (rawType === "PDF" || rawType === "VIDEO" || rawType === "BUNDLE" || rawType === "SHARED") {
    return rawType;
  }
  return null;
}

export function toVirtualGuideType(guideId: string): GuideEntitlementType | null {
  if (guideId === VIRTUAL_GUIDE_IDS.PDF) {
    return "PDF";
  }
  if (guideId === VIRTUAL_GUIDE_IDS.VIDEO) {
    return "VIDEO";
  }
  if (guideId === VIRTUAL_GUIDE_IDS.BUNDLE) {
    return "BUNDLE";
  }
  return null;
}
