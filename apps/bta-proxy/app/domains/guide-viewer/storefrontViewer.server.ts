import prisma from "~/db.server.ts";
import { buildGkvSignedUrl } from "~/domains/guide-viewer/signedUrl";
import {
  listEligibleSharedCategories,
  pickLatestPdfAndVideoForCategory,
  toSharedCategoryIdFromGuideId,
  toSharedGuideIdFromCategoryId,
} from "~/domains/guide-viewer/sharedVirtualGuides.server.ts";
import {
  canAccessAssetKind,
  resolveEntitlementExpiry,
  toGuideEntitlementType,
  toVirtualGuideType,
  type GuideEntitlementType,
  type GuideExtensionEntitlements,
  loadGuideExtensionEntitlements,
  VIRTUAL_GUIDE_IDS,
  VIRTUAL_GUIDE_TITLES,
} from "~/domains/guide-viewer/v1EntitlementAccess.server.ts";
import {
  resolveBundleRestaurantListId,
  VIRTUAL_BUNDLE_RESTAURANT_LIST_ID,
} from "~/domains/guide-viewer/v1RestaurantAccess.server.ts";
import { buildRestaurantPhotoUrls } from "~/domains/guide-viewer/restaurantPhotoUrls.server.ts";

const MEAT_TYPES = ["PORK", "BEEF", "CHICKEN", "LAMB", "SEAFOOD", "NONE", "UNKNOWN"];

type SupportedAssetKind = "PDF" | "VIDEO";

interface RestaurantBbox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

interface RestaurantFilterParams {
  vegan: string;
  halal: string;
  q: string;
  excludeMeat: string[];
  bbox: RestaurantBbox | null;
}

interface AccessibleGuide {
  id: string;
  title: string;
  type: string;
  thumbnailUrl: string | null;
  expiresAt: string;
  restaurantListId: string | null;
  isVirtual: boolean;
}

interface GuideAccessContext {
  now: Date;
  guideExtensionEntitlements: GuideExtensionEntitlements | null;
  accessibleGuides: AccessibleGuide[];
  accessibleGuideIds: Set<string>;
  accessibleRealGuideIds: string[];
}

export interface StorefrontGuideSummary {
  id: string;
  title: string;
  type: string;
  thumbnailUrl: string | null;
  expiresAt: string;
}

export interface StorefrontGuideAsset {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;
}

export interface StorefrontViewerCatalogItem {
  id: string;
  guideId: string;
  guideTitle: string;
  guideType: string;
  title: string;
  path: string;
  depth: number;
  pathSegments: string[];
  thumbnailUrl: string | null;
  expiresAt: string;
  pdfAsset: StorefrontGuideAsset | null;
  videoAsset: StorefrontGuideAsset | null;
}

export interface StorefrontCategoryNode {
  id: string;
  kind: string;
  name: string;
  slug: string;
  depth: number;
  sortOrder: number;
  children: StorefrontCategoryNode[];
}

export interface StorefrontCategoryAvailability {
  categoryId: string;
  pdfAsset: StorefrontGuideAsset | null;
  videoAsset: StorefrontGuideAsset | null;
}

export interface StorefrontGuideDetail extends StorefrontGuideSummary {
  assets: Array<{
    role: string;
    asset: StorefrontGuideAsset | null;
  }>;
  restaurantListId: string | null;
}

export interface StorefrontRestaurantItem {
  id: string;
  name: string;
  area: StorefrontRestaurantFilterOption | null;
  category: string | null;
  address: string | null;
  photoUrl: string | null;
  photoThumbnailUrl: string | null;
  lat: number;
  lng: number;
  tags: string[];
  memo: string | null;
  priority: number;
  mapUrl: string | null;
  dietary: {
    isVeganOnly: boolean;
    hasVeganOptions: boolean;
    veganLevel: string;
    meatTypes: string[];
    halalLevel: string;
    notes: string | null;
  } | null;
}

export interface StorefrontRestaurantFilterOption {
  id: string | null;
  name: string;
  slug: string | null;
}

export interface StorefrontRestaurantFilterOptions {
  areas: StorefrontRestaurantFilterOption[];
  categories: StorefrontRestaurantFilterOption[];
  meatTypes: string[];
}

export type StorefrontGuideDetailResult =
  | { ok: true; data: StorefrontGuideDetail }
  | { ok: false; reason: "not_found" | "forbidden" };

export type StorefrontSignedUrlResult =
  | {
      ok: true;
      data: {
        assetId: string;
        signedUrl: string;
        expiresAt: string;
        ttlSec: number;
      };
    }
  | { ok: false; reason: "not_found" | "forbidden" };

export type StorefrontRestaurantItemsResult =
  | { ok: true; items: StorefrontRestaurantItem[] }
  | { ok: false; reason: "forbidden" };

export type StorefrontRestaurantFilterOptionsResult =
  | { ok: true; data: StorefrontRestaurantFilterOptions }
  | { ok: false; reason: "forbidden" };

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
    return [];
  } catch {
    return [];
  }
}

function dedupePreserveOrder(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const raw of values) {
    const value = (raw || "").trim();
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

function sortMeatTypes(values: string[]): string[] {
  const rank = new Map(MEAT_TYPES.map((type, index) => [type, index]));
  return [...values].sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

async function sortLegacyCategoryNamesByMasterSortOrder(
  categoryNames: string[],
): Promise<string[]> {
  if (categoryNames.length === 0) {
    return [];
  }

  const wantedNames = new Set(categoryNames.map((name) => name.toLowerCase()));
  const masters = await prisma.gkvRestaurantCategory.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { name: true },
  });
  const rankByName = new Map<string, number>();

  for (const master of masters) {
    const key = master.name.trim().toLowerCase();
    if (!wantedNames.has(key) || rankByName.has(key)) {
      continue;
    }
    rankByName.set(key, rankByName.size);
  }

  return [...categoryNames].sort((left, right) => {
    const leftRank = rankByName.get(left.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rankByName.get(right.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  });
}

function parseBbox(raw: string | null): RestaurantBbox | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split(",").map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  return { minLng, minLat, maxLng, maxLat };
}

function createRestaurantFilterParams(request: Request): RestaurantFilterParams {
  const url = new URL(request.url);
  return {
    vegan: (url.searchParams.get("vegan") || "").trim(),
    halal: (url.searchParams.get("halal") || "").trim(),
    q: (url.searchParams.get("q") || "").trim().toLowerCase(),
    excludeMeat: (url.searchParams.get("exclude_meat") || "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter((value) => MEAT_TYPES.includes(value)),
    bbox: parseBbox(url.searchParams.get("bbox")),
  };
}

function buildRestaurantMapUrl(
  name: string,
  lat: number,
  lng: number,
  kakaoPlaceId: string | null,
): string | null {
  if (kakaoPlaceId) {
    return `https://place.map.kakao.com/${encodeURIComponent(kakaoPlaceId)}`;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return `https://map.kakao.com/link/map/${encodeURIComponent(name)},${lat},${lng}`;
}

function serializeStorefrontAsset(
  asset: {
    id: string;
    kind: string;
    title: string;
    description: string | null;
    mimeType: string;
    sizeBytes: bigint | null;
    durationSec: number | null;
  } | null,
): StorefrontGuideAsset | null {
  if (!asset) {
    return null;
  }
  return {
    id: asset.id,
    kind: asset.kind,
    title: asset.title,
    description: asset.description,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
    durationSec: asset.durationSec ?? null,
  };
}

async function loadCategoryTree(): Promise<StorefrontCategoryNode[]> {
  const rows = await prisma.gkvCategory.findMany({
    where: { isActive: true },
    orderBy: [{ depth: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const byId = new Map<string, StorefrontCategoryNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      kind: "SHARED",
      name: row.name,
      slug: row.slug,
      depth: row.depth,
      sortOrder: row.sortOrder,
      children: [],
    });
  }

  const roots: StorefrontCategoryNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id);
    if (!node) {
      continue;
    }
    if (row.parentId) {
      const parent = byId.get(row.parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  return roots;
}

async function buildCategoryPaths(categoryIds: string[]) {
  if (categoryIds.length === 0) {
    return new Map<string, string>();
  }

  const byId = new Map<string, { id: string; name: string; parentId: string | null }>();
  let queue = Array.from(new Set(categoryIds));

  while (queue.length > 0) {
    const unresolved = queue.filter((id) => !byId.has(id));
    if (unresolved.length === 0) {
      break;
    }

    const categories = await prisma.gkvCategory.findMany({
      where: { id: { in: unresolved } },
      select: { id: true, name: true, parentId: true },
    });
    if (categories.length === 0) {
      break;
    }

    const nextQueue: string[] = [];
    for (const category of categories) {
      byId.set(category.id, category);
      if (category.parentId && !byId.has(category.parentId)) {
        nextQueue.push(category.parentId);
      }
    }
    queue = nextQueue;
  }

  const paths = new Map<string, string>();
  for (const categoryId of categoryIds) {
    const names: string[] = [];
    const visited = new Set<string>();
    let currentId: string | null = categoryId;

    while (currentId) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      const current = byId.get(currentId);
      if (!current) {
        break;
      }
      names.push(current.name);
      currentId = current.parentId;
    }

    if (names.length > 0) {
      paths.set(categoryId, names.reverse().join(" / "));
    }
  }

  return paths;
}

function toPathSegments(path: string): string[] {
  return path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function compareViewerCatalogItems(
  left: StorefrontViewerCatalogItem,
  right: StorefrontViewerCatalogItem,
) {
  const length = Math.max(left.pathSegments.length, right.pathSegments.length);
  for (let index = 0; index < length; index += 1) {
    const leftSegment = left.pathSegments[index] ?? "";
    const rightSegment = right.pathSegments[index] ?? "";
    const segmentCompare = leftSegment.localeCompare(rightSegment);
    if (segmentCompare !== 0) {
      return segmentCompare;
    }
  }

  return left.guideTitle.localeCompare(right.guideTitle) || left.id.localeCompare(right.id);
}

async function loadGuideAccessContext(
  request: Request,
  customerId: string,
): Promise<GuideAccessContext> {
  const now = new Date();
  const guideExtensionEntitlements = await loadGuideExtensionEntitlements(request, customerId);
  const legacyEntitlements = await prisma.gkvEntitlement.findMany({
    where: {
      customerId,
      status: "ACTIVE",
      expiresAt: { gt: now },
    },
    select: { guideId: true, expiresAt: true },
  });
  const expiresByGuide = new Map(legacyEntitlements.map((item) => [item.guideId, item.expiresAt]));

  const guides = await prisma.gkvGuide.findMany({
    where: { isActive: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  const restaurantLinks = guides.length
    ? await prisma.gkvGuideRestaurantList.findMany({
        where: { guideId: { in: guides.map((guide) => guide.id) } },
      })
    : [];
  const restaurantListByGuide = new Map(
    restaurantLinks.map((item) => [item.guideId, item.restaurantListId]),
  );

  const accessibleGuides: AccessibleGuide[] = [];
  for (const guide of guides) {
    const type = toGuideEntitlementType(guide.type);
    const expiresAtByGuideExtension = type
      ? resolveEntitlementExpiry(type, guideExtensionEntitlements, now)
      : null;
    const expiresAtByLegacy = expiresByGuide.get(guide.id)?.toISOString() ?? null;
    const expiresAt = expiresAtByGuideExtension ?? expiresAtByLegacy;
    if (!expiresAt) {
      continue;
    }

    accessibleGuides.push({
      id: guide.id,
      title: guide.title,
      type: guide.type,
      thumbnailUrl: guide.thumbnailUrl,
      expiresAt,
      restaurantListId: restaurantListByGuide.get(guide.id) ?? null,
      isVirtual: false,
    });
  }

  const representedTypes = new Set(
    accessibleGuides
      .map((guide) => toGuideEntitlementType(guide.type))
      .filter((type): type is GuideEntitlementType => Boolean(type)),
  );

  let virtualBundleRestaurantListId: string | null | undefined;
  const virtualTypes: GuideEntitlementType[] = ["BUNDLE", "PDF", "VIDEO"];
  for (const type of virtualTypes) {
    if (representedTypes.has(type)) {
      continue;
    }
    const expiresAt = resolveEntitlementExpiry(type, guideExtensionEntitlements, now);
    if (!expiresAt) {
      continue;
    }

    if (type === "BUNDLE" && virtualBundleRestaurantListId === undefined) {
      virtualBundleRestaurantListId = await resolveBundleRestaurantListId();
    }

    accessibleGuides.push({
      id: VIRTUAL_GUIDE_IDS[type],
      title: VIRTUAL_GUIDE_TITLES[type],
      type,
      thumbnailUrl: null,
      expiresAt,
      restaurantListId: type === "BUNDLE" ? (virtualBundleRestaurantListId ?? null) : null,
      isVirtual: true,
    });
  }

  const sharedExpiry = resolveEntitlementExpiry("SHARED", guideExtensionEntitlements, now);
  if (sharedExpiry) {
    const sharedCategories = await listEligibleSharedCategories();
    for (const cat of sharedCategories) {
      const { pdfAsset, videoAsset } = await pickLatestPdfAndVideoForCategory(cat.id);
      if (!pdfAsset && !videoAsset) {
        continue;
      }

      accessibleGuides.push({
        id: toSharedGuideIdFromCategoryId(cat.id),
        title: cat.name,
        type: "SHARED",
        thumbnailUrl: null,
        expiresAt: sharedExpiry,
        restaurantListId: null,
        isVirtual: true,
      });
    }
  }

  return {
    now,
    guideExtensionEntitlements,
    accessibleGuides,
    accessibleGuideIds: new Set(accessibleGuides.map((guide) => guide.id)),
    accessibleRealGuideIds: accessibleGuides
      .filter((guide) => !guide.isVirtual)
      .map((guide) => guide.id),
  };
}

async function getNewestReadyAsset(kind: SupportedAssetKind) {
  return prisma.gkvAsset.findFirst({
    where: { kind, status: "READY", isActive: true },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      kind: true,
      title: true,
      description: true,
      mimeType: true,
      sizeBytes: true,
      durationSec: true,
      s3Key: true,
    },
  });
}

async function buildSharedVirtualStorefrontGuideDetail(
  guide: AccessibleGuide,
): Promise<StorefrontGuideDetail> {
  const categoryId = toSharedCategoryIdFromGuideId(guide.id);
  if (!categoryId) {
    throw new Error("Expected shared virtual guide id");
  }
  const { pdfAsset, videoAsset } = await pickLatestPdfAndVideoForCategory(categoryId);
  const assets: StorefrontGuideDetail["assets"] = [];
  if (pdfAsset) {
    assets.push({ role: "PDF", asset: serializeStorefrontAsset(pdfAsset) });
  }
  if (videoAsset) {
    assets.push({ role: "VIDEO", asset: serializeStorefrontAsset(videoAsset) });
  }

  return {
    id: guide.id,
    title: guide.title,
    type: guide.type,
    thumbnailUrl: guide.thumbnailUrl,
    expiresAt: guide.expiresAt,
    assets,
    restaurantListId: guide.restaurantListId,
  };
}

async function buildVirtualGuideDetail(guide: AccessibleGuide): Promise<StorefrontGuideDetail> {
  const newestPdfAsset = await getNewestReadyAsset("PDF");
  const newestVideoAsset = await getNewestReadyAsset("VIDEO");

  const assets =
    guide.type === "PDF"
      ? [{ role: "PDF", asset: serializeStorefrontAsset(newestPdfAsset) }]
      : guide.type === "VIDEO"
        ? [{ role: "VIDEO", asset: serializeStorefrontAsset(newestVideoAsset) }]
        : [
            { role: "PDF", asset: serializeStorefrontAsset(newestPdfAsset) },
            { role: "VIDEO", asset: serializeStorefrontAsset(newestVideoAsset) },
          ];

  return {
    id: guide.id,
    title: guide.title,
    type: guide.type,
    thumbnailUrl: guide.thumbnailUrl,
    expiresAt: guide.expiresAt,
    assets,
    restaurantListId: guide.restaurantListId,
  };
}

async function listLegacyRestaurantItems(
  listId: string,
  filters: RestaurantFilterParams,
  customerId: string,
): Promise<StorefrontRestaurantItem[]> {
  const rows = await prisma.gkvRestaurantItem.findMany({
    where: { listId },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  const dietaryRows = await prisma.gkvRestaurantDietary.findMany({
    where: { restaurantId: { in: rows.map((row) => row.id) } },
  });
  const dietaryById = new Map(dietaryRows.map((row) => [row.restaurantId, row]));

  return rows
    .filter((item) => {
      if (filters.bbox) {
        if (item.lat < filters.bbox.minLat || item.lat > filters.bbox.maxLat) {
          return false;
        }
        if (item.lng < filters.bbox.minLng || item.lng > filters.bbox.maxLng) {
          return false;
        }
      }
      if (filters.q && !`${item.name} ${item.address || ""}`.toLowerCase().includes(filters.q)) {
        return false;
      }

      const dietary = dietaryById.get(item.id);
      if (!dietary) {
        return true;
      }

      if (filters.vegan === "only" && !dietary.isVeganOnly) {
        return false;
      }
      if (filters.vegan === "options" && !(dietary.isVeganOnly || dietary.hasVeganOptions)) {
        return false;
      }
      if (filters.halal && dietary.halalLevel !== filters.halal) {
        return false;
      }

      if (filters.excludeMeat.length > 0) {
        const meats = parseJsonArray(dietary.meatTypes);
        if (filters.excludeMeat.some((meat) => meats.includes(meat))) {
          return false;
        }
      }
      return true;
    })
    .map((item) => {
      const dietary = dietaryById.get(item.id);
      return {
        id: item.id,
        name: item.name,
        area: null,
        category: item.category,
        address: item.address,
        ...buildRestaurantPhotoUrls(item.id, item, customerId),
        lat: item.lat,
        lng: item.lng,
        tags: parseJsonArray(item.tags),
        memo: item.memo,
        priority: item.priority,
        mapUrl: item.mapUrl,
        dietary: dietary
          ? {
              isVeganOnly: dietary.isVeganOnly,
              hasVeganOptions: dietary.hasVeganOptions,
              veganLevel: dietary.veganLevel,
              meatTypes: parseJsonArray(dietary.meatTypes),
              halalLevel: dietary.halalLevel,
              notes: dietary.notes,
            }
          : null,
      };
    });
}

async function listVirtualRestaurantItems(
  filters: RestaurantFilterParams,
  customerId: string,
): Promise<StorefrontRestaurantItem[]> {
  const rows = await prisma.gkvRestaurant.findMany({
    where: { isActive: true },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  const mappings = rows.length
    ? await prisma.gkvRestaurantCategoryMap.findMany({
        where: { restaurantId: { in: rows.map((item) => item.id) } },
      })
    : [];
  const areaIds = Array.from(new Set(rows.map((item) => item.areaId)));
  const areas = areaIds.length
    ? await prisma.gkvArea.findMany({
        where: { id: { in: areaIds } },
        select: { id: true, name: true, slug: true },
      })
    : [];
  const categoryIds = Array.from(new Set(mappings.map((mapping) => mapping.categoryId)));
  const categories = categoryIds.length
    ? await prisma.gkvRestaurantCategory.findMany({
        where: { id: { in: categoryIds } },
      })
    : [];
  const areaById = new Map(areas.map((area) => [area.id, area]));
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const categoryNamesByRestaurant = new Map<string, string[]>();

  for (const mapping of mappings) {
    const category = categoryById.get(mapping.categoryId);
    if (!category) {
      continue;
    }
    const names = categoryNamesByRestaurant.get(mapping.restaurantId) ?? [];
    names.push(category.name);
    categoryNamesByRestaurant.set(mapping.restaurantId, names);
  }

  return rows
    .filter((item) => {
      if (filters.bbox) {
        if (item.lat < filters.bbox.minLat || item.lat > filters.bbox.maxLat) {
          return false;
        }
        if (item.lng < filters.bbox.minLng || item.lng > filters.bbox.maxLng) {
          return false;
        }
      }
      if (filters.q && !`${item.name} ${item.address || ""}`.toLowerCase().includes(filters.q)) {
        return false;
      }

      const meats = parseJsonArray(item.meatTypes).map((meat) => meat.toUpperCase());
      if (
        filters.excludeMeat.length > 0 &&
        filters.excludeMeat.some((meat) => meats.includes(meat))
      ) {
        return false;
      }
      if ((filters.vegan === "only" || filters.vegan === "options") && !item.veganRecommended) {
        return false;
      }
      if (filters.halal && filters.halal !== "UNKNOWN") {
        return false;
      }
      return true;
    })
    .map((item) => {
      const area = areaById.get(item.areaId);
      const categoryNames = categoryNamesByRestaurant.get(item.id) ?? [];
      return {
        id: item.id,
        name: item.name,
        area: area
          ? {
              id: area.id,
              name: area.name,
              slug: area.slug,
            }
          : null,
        category: categoryNames[0] ?? null,
        address: item.address,
        ...buildRestaurantPhotoUrls(item.id, item, customerId),
        lat: item.lat,
        lng: item.lng,
        tags: parseJsonArray(item.tags),
        memo: item.memo,
        priority: item.priority,
        mapUrl:
          item.naverPlaceUrl ||
          buildRestaurantMapUrl(item.name, item.lat, item.lng, item.kakaoPlaceId),
        dietary: {
          isVeganOnly: false,
          hasVeganOptions: item.veganRecommended,
          veganLevel: item.veganRecommended ? "VEGAN_OPTIONS" : "UNKNOWN",
          meatTypes: parseJsonArray(item.meatTypes),
          halalLevel: "UNKNOWN",
          notes: null,
        },
      };
    });
}

async function listVirtualRestaurantFilterOptions(): Promise<StorefrontRestaurantFilterOptions> {
  const [areas, categories] = await Promise.all([
    prisma.gkvArea.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, slug: true },
    }),
    prisma.gkvRestaurantCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, slug: true },
    }),
  ]);

  return {
    areas: areas.map((area) => ({
      id: area.id,
      name: area.name,
      slug: area.slug,
    })),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
    })),
    meatTypes: [...MEAT_TYPES],
  };
}

async function listLegacyRestaurantFilterOptions(
  listId: string,
): Promise<StorefrontRestaurantFilterOptions> {
  const rows = await prisma.gkvRestaurantItem.findMany({
    where: { listId },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    select: { id: true, category: true },
  });
  const dietaryRows = rows.length
    ? await prisma.gkvRestaurantDietary.findMany({
        where: { restaurantId: { in: rows.map((row) => row.id) } },
        select: { meatTypes: true },
      })
    : [];

  const categoryNames = dedupePreserveOrder(rows.map((row) => row.category));
  const sortedCategoryNames = await sortLegacyCategoryNamesByMasterSortOrder(categoryNames);
  const meatTypes = sortMeatTypes(
    dedupePreserveOrder(
      dietaryRows.flatMap((row) =>
        parseJsonArray(row.meatTypes).map((value) => value.trim().toUpperCase()),
      ),
    ).filter((value) => MEAT_TYPES.includes(value)),
  );

  return {
    areas: [],
    categories: sortedCategoryNames.map((name) => ({
      id: null,
      name,
      slug: null,
    })),
    meatTypes,
  };
}

export async function getStorefrontRestaurantFilterOptionsByListId(
  listId: string,
): Promise<StorefrontRestaurantFilterOptions> {
  return listId === VIRTUAL_BUNDLE_RESTAURANT_LIST_ID
    ? listVirtualRestaurantFilterOptions()
    : listLegacyRestaurantFilterOptions(listId);
}

export async function getStorefrontRestaurantItemsByListId(
  request: Request,
  listId: string,
  customerId = "anonymous",
): Promise<StorefrontRestaurantItem[]> {
  const filters = createRestaurantFilterParams(request);
  return listId === VIRTUAL_BUNDLE_RESTAURANT_LIST_ID
    ? listVirtualRestaurantItems(filters, customerId)
    : listLegacyRestaurantItems(listId, filters, customerId);
}

export async function getStorefrontViewerCatalog(
  request: Request,
  customerId: string,
): Promise<{ items: StorefrontViewerCatalogItem[] }> {
  const access = await loadGuideAccessContext(request, customerId);
  const guideById = new Map(access.accessibleGuides.map((guide) => [guide.id, guide]));
  const itemsByKey = new Map<string, StorefrontViewerCatalogItem>();

  if (access.accessibleRealGuideIds.length > 0) {
    const guideAssets = await prisma.gkvGuideAsset.findMany({
      where: { guideId: { in: access.accessibleRealGuideIds } },
      orderBy: [{ guideId: "asc" }, { role: "asc" }],
    });
    const assetIds = Array.from(new Set(guideAssets.map((item) => item.assetId)));
    const assets = assetIds.length
      ? await prisma.gkvAsset.findMany({
          where: {
            id: { in: assetIds },
            isActive: true,
            status: "READY",
          },
          select: {
            id: true,
            kind: true,
            title: true,
            description: true,
            mimeType: true,
            sizeBytes: true,
            durationSec: true,
          },
        })
      : [];
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const mappings = assetIds.length
      ? await prisma.gkvAssetCategory.findMany({
          where: { assetId: { in: assetIds } },
        })
      : [];
    const categoryIds = Array.from(new Set(mappings.map((mapping) => mapping.categoryId)));
    const categoryPathMap = await buildCategoryPaths(categoryIds);
    const categoryPathsByAsset = new Map<string, string[]>();

    for (const mapping of mappings) {
      const path = categoryPathMap.get(mapping.categoryId);
      if (!path) {
        continue;
      }
      const paths = categoryPathsByAsset.get(mapping.assetId) ?? [];
      if (!paths.includes(path)) {
        paths.push(path);
      }
      categoryPathsByAsset.set(mapping.assetId, paths);
    }

    for (const guideAsset of guideAssets) {
      const guide = guideById.get(guideAsset.guideId);
      const asset = assetById.get(guideAsset.assetId);
      if (!guide || !asset) {
        continue;
      }

      const serializedAsset = serializeStorefrontAsset(asset);
      if (!serializedAsset) {
        continue;
      }

      const paths = categoryPathsByAsset.get(asset.id) ?? [guide.title];
      for (const path of paths) {
        const pathSegments = toPathSegments(path);
        const normalizedPath = pathSegments.length > 0 ? pathSegments.join(" / ") : guide.title;
        const title = pathSegments[pathSegments.length - 1] ?? guide.title;
        const key = `${guide.id}::${normalizedPath}`;
        const existing = itemsByKey.get(key) ?? {
          id: key,
          guideId: guide.id,
          guideTitle: guide.title,
          guideType: guide.type,
          title,
          path: normalizedPath,
          depth: Math.max(pathSegments.length, 1),
          pathSegments: pathSegments.length > 0 ? pathSegments : [guide.title],
          thumbnailUrl: guide.thumbnailUrl,
          expiresAt: guide.expiresAt,
          pdfAsset: null,
          videoAsset: null,
        };

        if (asset.kind === "PDF") {
          existing.pdfAsset = serializedAsset;
        } else if (asset.kind === "VIDEO") {
          existing.videoAsset = serializedAsset;
        }

        itemsByKey.set(key, existing);
      }
    }
  }

  for (const guide of access.accessibleGuides.filter((item) => item.isVirtual)) {
    const detail = toSharedCategoryIdFromGuideId(guide.id)
      ? await buildSharedVirtualStorefrontGuideDetail(guide)
      : await buildVirtualGuideDetail(guide);
    const pathSegments = [guide.title];
    const item: StorefrontViewerCatalogItem = {
      id: `${guide.id}::${guide.title}`,
      guideId: guide.id,
      guideTitle: guide.title,
      guideType: guide.type,
      title: guide.title,
      path: guide.title,
      depth: 1,
      pathSegments,
      thumbnailUrl: guide.thumbnailUrl,
      expiresAt: guide.expiresAt,
      pdfAsset: null,
      videoAsset: null,
    };

    for (const row of detail.assets) {
      if (!row.asset) {
        continue;
      }
      if (row.asset.kind === "PDF") {
        item.pdfAsset = row.asset;
      }
      if (row.asset.kind === "VIDEO") {
        item.videoAsset = row.asset;
      }
    }

    if (item.pdfAsset || item.videoAsset) {
      itemsByKey.set(item.id, item);
    }
  }

  return {
    items: Array.from(itemsByKey.values())
      .filter((item) => item.pdfAsset || item.videoAsset)
      .sort(compareViewerCatalogItems),
  };
}

export async function listStorefrontCategories(
  request: Request,
  customerId: string,
): Promise<{ items: StorefrontCategoryNode[] }> {
  const access = await loadGuideAccessContext(request, customerId);
  const assets = await prisma.gkvAsset.findMany({
    where: {
      isActive: true,
      status: "READY",
      kind: { in: ["PDF", "VIDEO"] },
    },
    select: { id: true, kind: true },
  });
  if (assets.length === 0) {
    return { items: [] };
  }

  const allowedGuideAssetIds = access.accessibleRealGuideIds.length
    ? new Set(
        (
          await prisma.gkvGuideAsset.findMany({
            where: {
              guideId: { in: access.accessibleRealGuideIds },
              assetId: { in: assets.map((asset) => asset.id) },
            },
            select: { assetId: true },
          })
        ).map((row) => row.assetId),
      )
    : new Set<string>();

  const accessibleAssetIds = assets
    .filter(
      (asset) =>
        allowedGuideAssetIds.has(asset.id) ||
        canAccessAssetKind(asset.kind, access.guideExtensionEntitlements, access.now),
    )
    .map((asset) => asset.id);
  if (accessibleAssetIds.length === 0) {
    return { items: [] };
  }

  const accessibleCategoryIds = new Set(
    (
      await prisma.gkvAssetCategory.findMany({
        where: { assetId: { in: accessibleAssetIds } },
        select: { categoryId: true },
      })
    ).map((row) => row.categoryId),
  );
  if (accessibleCategoryIds.size === 0) {
    return { items: [] };
  }

  const keepAccessibleBranches = (nodes: StorefrontCategoryNode[]): StorefrontCategoryNode[] =>
    nodes.flatMap((node) => {
      const children = keepAccessibleBranches(node.children);
      if (!accessibleCategoryIds.has(node.id) && children.length === 0) {
        return [];
      }
      return [{ ...node, children }];
    });

  return { items: keepAccessibleBranches(await loadCategoryTree()) };
}

export async function getStorefrontCategoryAvailability(
  request: Request,
  customerId: string,
  categoryId: string,
): Promise<StorefrontCategoryAvailability> {
  const access = await loadGuideAccessContext(request, customerId);
  const assets = await prisma.gkvAsset.findMany({
    where: {
      isActive: true,
      status: "READY",
      kind: { in: ["PDF", "VIDEO"] },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      kind: true,
      title: true,
      description: true,
      mimeType: true,
      sizeBytes: true,
      durationSec: true,
    },
  });
  if (assets.length === 0) {
    return { categoryId, pdfAsset: null, videoAsset: null };
  }

  const mappings = await prisma.gkvAssetCategory.findMany({
    where: {
      categoryId,
      assetId: { in: assets.map((asset) => asset.id) },
    },
    select: { assetId: true },
  });
  const mappedAssetIds = new Set(mappings.map((mapping) => mapping.assetId));
  const categoryAssets = assets.filter((asset) => mappedAssetIds.has(asset.id));
  if (categoryAssets.length === 0) {
    return { categoryId, pdfAsset: null, videoAsset: null };
  }

  const allowedGuideAssetIds = access.accessibleRealGuideIds.length
    ? new Set(
        (
          await prisma.gkvGuideAsset.findMany({
            where: {
              assetId: { in: categoryAssets.map((asset) => asset.id) },
              guideId: { in: access.accessibleRealGuideIds },
            },
            select: { assetId: true },
          })
        ).map((row) => row.assetId),
      )
    : new Set<string>();

  let pdfAsset: StorefrontGuideAsset | null = null;
  let videoAsset: StorefrontGuideAsset | null = null;

  for (const asset of categoryAssets) {
    const allowed =
      canAccessAssetKind(asset.kind, access.guideExtensionEntitlements, access.now) ||
      allowedGuideAssetIds.has(asset.id);
    if (!allowed) {
      continue;
    }

    const serialized = serializeStorefrontAsset(asset);
    if (!serialized) {
      continue;
    }

    if (asset.kind === "PDF" && !pdfAsset) {
      pdfAsset = serialized;
      continue;
    }
    if (asset.kind === "VIDEO" && !videoAsset) {
      videoAsset = serialized;
    }
  }

  return { categoryId, pdfAsset, videoAsset };
}

export async function listStorefrontGuides(
  request: Request,
  customerId: string,
): Promise<{ items: StorefrontGuideSummary[] }> {
  const access = await loadGuideAccessContext(request, customerId);
  return {
    items: access.accessibleGuides.map((guide) => ({
      id: guide.id,
      title: guide.title,
      type: guide.type,
      thumbnailUrl: guide.thumbnailUrl,
      expiresAt: guide.expiresAt,
    })),
  };
}

export async function getStorefrontGuideDetail(
  request: Request,
  customerId: string,
  guideId: string,
): Promise<StorefrontGuideDetailResult> {
  const access = await loadGuideAccessContext(request, customerId);
  const accessibleGuide = access.accessibleGuides.find((guide) => guide.id === guideId);
  if (!accessibleGuide) {
    if (toVirtualGuideType(guideId) || toSharedCategoryIdFromGuideId(guideId)) {
      return { ok: false, reason: "forbidden" };
    }
    const guide = await prisma.gkvGuide.findUnique({ where: { id: guideId } });
    if (!guide || !guide.isActive) {
      return { ok: false, reason: "not_found" };
    }
    return { ok: false, reason: "forbidden" };
  }

  if (accessibleGuide.isVirtual) {
    return {
      ok: true,
      data: toSharedCategoryIdFromGuideId(accessibleGuide.id)
        ? await buildSharedVirtualStorefrontGuideDetail(accessibleGuide)
        : await buildVirtualGuideDetail(accessibleGuide),
    };
  }

  const guideAssets = await prisma.gkvGuideAsset.findMany({
    where: { guideId },
    orderBy: [{ role: "asc" }],
  });
  const assetIds = guideAssets.map((item) => item.assetId);
  const assets = assetIds.length
    ? await prisma.gkvAsset.findMany({
        where: {
          id: { in: assetIds },
          isActive: true,
          status: "READY",
        },
        select: {
          id: true,
          kind: true,
          title: true,
          description: true,
          mimeType: true,
          sizeBytes: true,
          durationSec: true,
        },
      })
    : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  return {
    ok: true,
    data: {
      id: accessibleGuide.id,
      title: accessibleGuide.title,
      type: accessibleGuide.type,
      thumbnailUrl: accessibleGuide.thumbnailUrl,
      expiresAt: accessibleGuide.expiresAt,
      assets: guideAssets.map((item) => ({
        role: item.role,
        asset: serializeStorefrontAsset(assetById.get(item.assetId) ?? null),
      })),
      restaurantListId: accessibleGuide.restaurantListId,
    },
  };
}

async function canAccessVirtualAsset(
  access: GuideAccessContext,
  asset: { id: string; kind: string },
): Promise<boolean> {
  const virtualGuideId =
    asset.kind === "PDF"
      ? VIRTUAL_GUIDE_IDS.PDF
      : asset.kind === "VIDEO"
        ? VIRTUAL_GUIDE_IDS.VIDEO
        : null;

  if (!virtualGuideId || !access.accessibleGuideIds.has(virtualGuideId)) {
    return false;
  }

  const newest = await getNewestReadyAsset(asset.kind as SupportedAssetKind);
  return newest?.id === asset.id;
}

export async function issueStorefrontAssetSignedUrl(
  request: Request,
  customerId: string,
  assetId: string,
): Promise<StorefrontSignedUrlResult> {
  const asset = await prisma.gkvAsset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      kind: true,
      isActive: true,
      status: true,
      s3Key: true,
    },
  });
  if (!asset || !asset.isActive || asset.status !== "READY") {
    return { ok: false, reason: "not_found" };
  }

  const access = await loadGuideAccessContext(request, customerId);
  const allowedByGuideExtension = canAccessAssetKind(
    asset.kind,
    access.guideExtensionEntitlements,
    access.now,
  );
  const guideAsset = access.accessibleRealGuideIds.length
    ? await prisma.gkvGuideAsset.findFirst({
        where: {
          assetId,
          guideId: { in: access.accessibleRealGuideIds },
        },
      })
    : null;

  const allowedByRealGuide = Boolean(guideAsset);
  const allowedByVirtualGuide = await canAccessVirtualAsset(access, asset);
  if (!allowedByGuideExtension && !allowedByRealGuide && !allowedByVirtualGuide) {
    return { ok: false, reason: "forbidden" };
  }

  const signed = buildGkvSignedUrl({
    assetId,
    customerId,
    s3Key: asset.s3Key,
  });

  return {
    ok: true,
    data: {
      assetId,
      signedUrl: signed.url,
      expiresAt: signed.expiresAt,
      ttlSec: signed.ttlSec,
    },
  };
}

export async function listStorefrontRestaurantItems(
  request: Request,
  customerId: string,
  listId: string,
): Promise<StorefrontRestaurantItemsResult> {
  const access = await loadGuideAccessContext(request, customerId);
  const allowed = access.accessibleGuides.some((guide) => guide.restaurantListId === listId);
  if (!allowed) {
    return { ok: false, reason: "forbidden" };
  }

  return {
    ok: true,
    items: await getStorefrontRestaurantItemsByListId(request, listId, customerId),
  };
}

export async function listStorefrontRestaurantFilterOptions(
  request: Request,
  customerId: string,
  listId: string,
): Promise<StorefrontRestaurantFilterOptionsResult> {
  const access = await loadGuideAccessContext(request, customerId);
  const allowed = access.accessibleGuides.some((guide) => guide.restaurantListId === listId);
  if (!allowed) {
    return { ok: false, reason: "forbidden" };
  }

  const data = await getStorefrontRestaurantFilterOptionsByListId(listId);
  return { ok: true, data };
}
