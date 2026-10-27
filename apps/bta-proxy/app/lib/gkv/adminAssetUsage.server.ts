import type { GkvAsset, GkvAssetCategory, GkvCategory } from "@prisma/client";
import prisma from "~/db.server";
import { serializeGkvAssetForJson } from "~/lib/gkv/assetResponse.server";

type AssetKind = "PDF" | "VIDEO";

type CategoryPathRow = Pick<GkvCategory, "id" | "name" | "parentId">;

type AssetUsageItem = ReturnType<typeof serializeGkvAssetForJson<GkvAsset>> & {
  categoryIds: string[];
  categoryPaths: string[];
  usageCategoryCount: number;
  currentCategoryIds: string[];
  currentCategoryPaths: string[];
  isCurrentForCategory?: boolean;
};

function isAssetKind(kind: string): kind is AssetKind {
  return kind === "PDF" || kind === "VIDEO";
}

function buildCategoryPathMap(categories: CategoryPathRow[]): Map<string, string> {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const cache = new Map<string, string>();

  const resolve = (categoryId: string): string => {
    const cached = cache.get(categoryId);
    if (cached) return cached;

    const category = byId.get(categoryId);
    if (!category) {
      cache.set(categoryId, categoryId);
      return categoryId;
    }

    const path = category.parentId
      ? `${resolve(category.parentId)} / ${category.name}`
      : category.name;
    cache.set(categoryId, path);
    return path;
  };

  categories.forEach((category) => resolve(category.id));
  return cache;
}

function compareAssetRecencyDesc(a: Pick<GkvAsset, "updatedAt" | "createdAt" | "id">, b: Pick<GkvAsset, "updatedAt" | "createdAt" | "id">) {
  const updatedDiff = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (updatedDiff !== 0) return updatedDiff;
  const createdDiff = b.createdAt.getTime() - a.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  return b.id.localeCompare(a.id);
}

function mapByAssetId(mappings: GkvAssetCategory[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const mapping of mappings) {
    const list = result.get(mapping.assetId) ?? [];
    list.push(mapping.categoryId);
    result.set(mapping.assetId, list);
  }
  return result;
}

async function loadCurrentAssetIdByCategoryKind(categoryIds: string[]) {
  const uniqueCategoryIds = Array.from(new Set(categoryIds));
  if (uniqueCategoryIds.length === 0) return new Map<string, string>();

  const mappings = await prisma.gkvAssetCategory.findMany({
    where: { categoryId: { in: uniqueCategoryIds } },
  });
  if (mappings.length === 0) return new Map<string, string>();

  const assetIds = Array.from(new Set(mappings.map((mapping) => mapping.assetId)));
  const assets = await prisma.gkvAsset.findMany({
    where: {
      id: { in: assetIds },
      status: "READY",
      isActive: true,
    },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const current = new Map<string, string>();

  for (const mapping of mappings) {
    const asset = assetById.get(mapping.assetId);
    if (!asset || !isAssetKind(asset.kind)) continue;

    const key = `${mapping.categoryId}:${asset.kind}`;
    const previousId = current.get(key);
    const previous = previousId ? assetById.get(previousId) : null;
    if (!previous || compareAssetRecencyDesc(asset, previous) < 0) {
      current.set(key, asset.id);
    }
  }

  return current;
}

async function buildUsageItems(
  assets: GkvAsset[],
  options: {
    focusCategoryId?: string;
    allCategories?: CategoryPathRow[];
  } = {}
): Promise<AssetUsageItem[]> {
  if (assets.length === 0) return [];

  const assetIds = assets.map((asset) => asset.id);
  const mappings = await prisma.gkvAssetCategory.findMany({
    where: { assetId: { in: assetIds } },
  });
  const categoryIds = Array.from(new Set(mappings.map((mapping) => mapping.categoryId)));
  const categories =
    options.allCategories ??
    (categoryIds.length
      ? await prisma.gkvCategory.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true, parentId: true },
        })
      : []);
  const pathByCategoryId = buildCategoryPathMap(categories);
  const categoryIdsByAssetId = mapByAssetId(mappings);
  const currentByCategoryKind = await loadCurrentAssetIdByCategoryKind(categoryIds);

  return assets.map((asset) => {
    const linkedCategoryIds = categoryIdsByAssetId.get(asset.id) ?? [];
    const currentCategoryIds = isAssetKind(asset.kind)
      ? linkedCategoryIds.filter(
          (categoryId) => currentByCategoryKind.get(`${categoryId}:${asset.kind}`) === asset.id
        )
      : [];

    return {
      ...serializeGkvAssetForJson(asset),
      categoryIds: linkedCategoryIds,
      categoryPaths: linkedCategoryIds.map((categoryId) => pathByCategoryId.get(categoryId) ?? categoryId),
      usageCategoryCount: linkedCategoryIds.length,
      currentCategoryIds,
      currentCategoryPaths: currentCategoryIds.map(
        (categoryId) => pathByCategoryId.get(categoryId) ?? categoryId
      ),
      ...(options.focusCategoryId
        ? {
            isCurrentForCategory:
              isAssetKind(asset.kind) &&
              currentByCategoryKind.get(`${options.focusCategoryId}:${asset.kind}`) === asset.id,
          }
        : {}),
    };
  });
}

export async function listGkvAssetsWithUsage() {
  const assets = await prisma.gkvAsset.findMany({
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });

  return {
    items: await buildUsageItems(assets),
  };
}

export async function getCategoryAssetManagement(categoryId: string) {
  const category = await prisma.gkvCategory.findUnique({ where: { id: categoryId } });
  if (!category) return null;

  const allCategories = await prisma.gkvCategory.findMany({
    select: { id: true, name: true, parentId: true },
  });
  const pathByCategoryId = buildCategoryPathMap(allCategories);

  const directMappings = await prisma.gkvAssetCategory.findMany({
    where: { categoryId },
    select: { assetId: true, categoryId: true },
  });
  const assetIds = directMappings.map((mapping) => mapping.assetId);
  const assets = assetIds.length
    ? await prisma.gkvAsset.findMany({
        where: { id: { in: assetIds } },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      })
    : [];

  const items = await buildUsageItems(assets, {
    focusCategoryId: categoryId,
    allCategories,
  });

  const current = {
    pdf: items.find((asset) => asset.kind === "PDF" && asset.isCurrentForCategory) ?? null,
    video: items.find((asset) => asset.kind === "VIDEO" && asset.isCurrentForCategory) ?? null,
  };

  const attachedAssetIds = new Set(assetIds);
  const availableSeed = await prisma.gkvAsset.findMany({
    where: {
      id: assetIds.length > 0 ? { notIn: assetIds } : undefined,
      status: "READY",
      isActive: true,
      kind: { in: ["PDF", "VIDEO"] },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 200,
  });
  const availableUsageItems = await buildUsageItems(
    availableSeed.filter((asset) => !attachedAssetIds.has(asset.id)),
    { allCategories }
  );
  const availableAssets = availableUsageItems.filter((asset) => asset.usageCategoryCount === 0);

  return {
    category: {
      id: category.id,
      name: category.name,
      slug: category.slug,
      depth: category.depth,
      parentId: category.parentId,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      exposeAsGuide: category.exposeAsGuide,
      path: pathByCategoryId.get(category.id) ?? category.name,
    },
    current,
    items,
    availableAssets,
  };
}

export async function detachAssetFromCategory(categoryId: string, assetId: string) {
  const before = await getCategoryAssetManagement(categoryId);
  const asset = before?.items.find((item) => item.id === assetId);

  await prisma.gkvAssetCategory.deleteMany({
    where: { categoryId, assetId },
  });

  return {
    categoryId,
    assetId,
    detached: true,
    wasCurrentForCategory: Boolean(asset?.isCurrentForCategory),
  };
}

export async function deleteAssetFromCategoryContext(categoryId: string, assetId: string, force = false) {
  const mappings = await prisma.gkvAssetCategory.findMany({ where: { assetId } });
  const otherCategoryIds = mappings
    .map((mapping) => mapping.categoryId)
    .filter((linkedCategoryId) => linkedCategoryId !== categoryId);

  if (otherCategoryIds.length > 0 && !force) {
    return {
      ok: false as const,
      conflict: true,
      assetId,
      otherCategoryIds,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.gkvAssetCategory.deleteMany({ where: { assetId } });
    await tx.gkvGuideAsset.deleteMany({ where: { assetId } });
    await tx.gkvAsset.delete({ where: { id: assetId } });
  });

  return {
    ok: true as const,
    assetId,
    deleted: true,
  };
}

export async function promoteCategoryAsset(categoryId: string, assetId: string) {
  const mappings = await prisma.gkvAssetCategory.findMany({ where: { assetId } });
  const isAttachedToCategory = mappings.some((mapping) => mapping.categoryId === categoryId);
  if (!isAttachedToCategory) {
    throw new Error("이 카테고리에 연결된 asset이 아닙니다.");
  }

  const otherCategoryIds = mappings
    .map((mapping) => mapping.categoryId)
    .filter((linkedCategoryId) => linkedCategoryId !== categoryId);
  if (otherCategoryIds.length > 0) {
    throw new Error("여러 카테고리에 연결된 asset은 현재 파일로 승격할 수 없습니다.");
  }

  await prisma.gkvAsset.update({
    where: { id: assetId },
    data: { updatedAt: new Date() },
  });

  return { categoryId, assetId, promoted: true };
}

export async function attachUnassignedAssetAsCurrent(categoryId: string, assetId: string) {
  const asset = await prisma.gkvAsset.findUnique({ where: { id: assetId } });
  if (!asset || !isAssetKind(asset.kind)) {
    throw new Error("PDF 또는 VIDEO asset을 찾을 수 없습니다.");
  }
  if (asset.status !== "READY" || !asset.isActive) {
    throw new Error("READY/ACTIVE asset만 현재 파일로 연결할 수 있습니다.");
  }

  const mappings = await prisma.gkvAssetCategory.findMany({ where: { assetId } });
  const otherCategoryIds = mappings
    .map((mapping) => mapping.categoryId)
    .filter((linkedCategoryId) => linkedCategoryId !== categoryId);
  if (otherCategoryIds.length > 0) {
    throw new Error("이미 다른 카테고리에 연결된 asset은 여기서 바로 연결할 수 없습니다.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.gkvAssetCategory.createMany({
      data: [{ categoryId, assetId }],
      skipDuplicates: true,
    });
    await tx.gkvAsset.update({
      where: { id: assetId },
      data: { updatedAt: new Date() },
    });
  });

  return { categoryId, assetId, attached: true, promoted: true };
}
