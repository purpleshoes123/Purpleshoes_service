import { randomUUID } from "crypto";
import prisma from "~/db.server.ts";
import type { GkvDomainKind } from "~/domains/guide-viewer/adminUiSchemas";
import { slugify } from "~/domains/guide-viewer/adminUiSchemas";

const SHARED_CATEGORY_KIND = "SHARED";

export type ScopedCategoryInput = {
  id?: string;
  name: string;
  slug: string;
  depth: 1 | 2 | 3;
  parentId?: string;
  sortOrder: number;
  isActive: boolean;
};

export type ScopedCategoryUpdateInput = Partial<ScopedCategoryInput>;

export type ScopedAssetUpsertInput = {
  id?: string;
  title: string;
  categoryIds: string[];
  file: {
    assetId: string;
    s3Bucket: string;
    s3Key: string;
    mimeType: string;
    sizeBytes?: number;
    status: "READY";
  };
  thumbnail?: {
    assetId?: string;
    s3Bucket: string;
    s3Key: string;
    mimeType: "image/jpeg" | "image/png";
    sizeBytes?: number;
    status: "READY";
  };
  isActive: boolean;
  description?: string;
};

type ScopedCategoryNode = {
  id: string;
  kind: string;
  name: string;
  slug: string;
  depth: number;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  children: ScopedCategoryNode[];
};

function buildScopedCategoryTree(
  rows: Array<{
    id: string;
    kind: string;
    name: string;
    slug: string;
    depth: number;
    parentId: string | null;
    sortOrder: number;
    isActive: boolean;
  }>,
): ScopedCategoryNode[] {
  const byId = new Map<string, ScopedCategoryNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      kind: SHARED_CATEGORY_KIND,
      name: row.name,
      slug: row.slug,
      depth: row.depth,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      children: [],
    });
  }

  const roots: ScopedCategoryNode[] = [];
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

  const sortTree = (nodes: ScopedCategoryNode[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const node of nodes) {
      sortTree(node.children);
    }
  };
  sortTree(roots);
  return roots;
}

export async function listScopedCategories(kind: GkvDomainKind, includeInactive: boolean) {
  const rows = await prisma.gkvCategory.findMany({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ depth: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const tree = buildScopedCategoryTree(rows);

  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: SHARED_CATEGORY_KIND,
      name: row.name,
      slug: row.slug,
      depth: row.depth,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    tree,
  };
}

async function assertCategoryParent(
  kind: GkvDomainKind,
  depth: 1 | 2 | 3,
  parentId: string | undefined,
) {
  if (depth === 1) {
    if (parentId) {
      throw new Error("depth1 카테고리는 상위 카테고리를 가질 수 없습니다.");
    }
    return;
  }

  if (!parentId) {
    if (depth === 2) {
      throw new Error("depth2 카테고리는 depth1 상위 카테고리가 필요합니다.");
    }
    throw new Error("depth3 카테고리는 depth2 상위 카테고리가 필요합니다.");
  }

  const parent = await prisma.gkvCategory.findUnique({ where: { id: parentId } });
  if (!parent) {
    throw new Error("유효한 상위 카테고리를 찾을 수 없습니다.");
  }

  if (depth === 2 && parent.depth !== 1) {
    throw new Error("depth2 카테고리는 depth1 상위 카테고리만 허용됩니다.");
  }

  if (depth === 3 && parent.depth !== 2) {
    throw new Error("depth3 카테고리는 depth2 상위 카테고리만 허용됩니다.");
  }
}

async function assertUniqueCategoryInSameParent(input: {
  parentId: string | undefined;
  name: string;
  slug: string;
  excludeId?: string;
}) {
  const parentId = input.parentId ?? null;
  const baseWhere = {
    parentId,
    ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
  };

  const sameName = await prisma.gkvCategory.findFirst({
    where: {
      ...baseWhere,
      name: input.name,
    },
    select: { id: true },
  });
  if (sameName) {
    throw new Error("동일 부모 아래 동일 name은 사용할 수 없습니다.");
  }

  const sameSlug = await prisma.gkvCategory.findFirst({
    where: {
      ...baseWhere,
      slug: input.slug,
    },
    select: { id: true },
  });
  if (sameSlug) {
    throw new Error("동일 부모 아래 동일 slug는 사용할 수 없습니다.");
  }
}

export async function createScopedCategory(kind: GkvDomainKind, payload: ScopedCategoryInput) {
  await assertCategoryParent(kind, payload.depth, payload.parentId);
  await assertUniqueCategoryInSameParent({
    parentId: payload.parentId,
    name: payload.name,
    slug: payload.slug,
  });

  const id = payload.id ?? `cat_${randomUUID()}`;
  const created = await prisma.gkvCategory.create({
    data: {
      id,
      kind: SHARED_CATEGORY_KIND,
      name: payload.name,
      slug: payload.slug,
      depth: payload.depth,
      parentId: payload.parentId ?? null,
      sortOrder: payload.sortOrder,
      isActive: payload.isActive,
    },
  });

  return {
    id: created.id,
    kind: SHARED_CATEGORY_KIND,
  };
}

export async function updateScopedCategory(
  kind: GkvDomainKind,
  id: string,
  payload: ScopedCategoryUpdateInput,
) {
  const current = await prisma.gkvCategory.findUnique({ where: { id } });
  if (!current) {
    throw new Error("카테고리를 찾을 수 없습니다.");
  }

  const nextDepth = (payload.depth ?? current.depth) as 1 | 2 | 3;
  if (![1, 2, 3].includes(nextDepth)) {
    throw new Error("지원하지 않는 카테고리 depth입니다.");
  }
  const nextParentId =
    payload.parentId !== undefined ? payload.parentId : (current.parentId ?? undefined);
  await assertCategoryParent(kind, nextDepth, nextParentId);
  await assertUniqueCategoryInSameParent({
    parentId: nextParentId,
    name: payload.name ?? current.name,
    slug: payload.slug ?? current.slug,
    excludeId: id,
  });

  await prisma.gkvCategory.update({
    where: { id },
    data: {
      kind: SHARED_CATEGORY_KIND,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.slug !== undefined ? { slug: payload.slug } : {}),
      ...(payload.depth !== undefined ? { depth: payload.depth } : {}),
      ...(payload.parentId !== undefined ? { parentId: payload.parentId ?? null } : {}),
      ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
      ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
    },
  });

  return { id, updated: true };
}

export async function deleteScopedCategory(kind: GkvDomainKind, id: string) {
  const current = await prisma.gkvCategory.findUnique({ where: { id } });
  if (!current) {
    throw new Error("카테고리를 찾을 수 없습니다.");
  }

  const allScopedCategories = await prisma.gkvCategory.findMany({
    select: { id: true, parentId: true },
  });
  const childrenByParent = new Map<string, string[]>();
  for (const category of allScopedCategories) {
    if (!category.parentId) {
      continue;
    }
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push(category.id);
    childrenByParent.set(category.parentId, children);
  }

  const descendantIds: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || descendantIds.includes(currentId)) {
      continue;
    }
    descendantIds.push(currentId);
    const children = childrenByParent.get(currentId) ?? [];
    stack.push(...children);
  }

  await prisma.$transaction(async (tx) => {
    await tx.gkvAssetCategory.deleteMany({ where: { categoryId: { in: descendantIds } } });
    await tx.gkvCategory.deleteMany({ where: { id: { in: descendantIds } } });
  });

  return { id, deleted: true, deletedCategoryIds: descendantIds };
}

function normalizeSearch(input: string | null | undefined): string | undefined {
  const value = (input || "").trim();
  return value.length > 0 ? value : undefined;
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

export async function listScopedAssets(
  kind: GkvDomainKind,
  filters: {
    q?: string | null;
    categoryId?: string | null;
    status?: string | null;
    hasThumbnail?: boolean;
    isActive?: boolean;
    limit: number;
    cursor?: string | null;
  },
) {
  const q = normalizeSearch(filters.q);
  const status = normalizeSearch(filters.status);
  const categoryId = normalizeSearch(filters.categoryId);

  const baseWhere: Record<string, unknown> = {
    kind,
    ...(q ? { title: { contains: q } } : {}),
    ...(status ? { status } : {}),
    ...(filters.hasThumbnail === true ? { thumbnailKey: { not: null } } : {}),
    ...(filters.hasThumbnail === false ? { thumbnailKey: null } : {}),
    ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
  };

  if (categoryId) {
    const mapped = await prisma.gkvAssetCategory.findMany({
      where: { categoryId },
      select: { assetId: true },
    });
    const ids = mapped.map((row) => row.assetId);
    if (ids.length === 0) {
      return { items: [], nextCursor: null };
    }
    baseWhere.id = { in: ids };
  }

  const where: Record<string, unknown> = { ...baseWhere };
  const cursorId = normalizeSearch(filters.cursor);
  if (cursorId) {
    const cursorRow = await prisma.gkvAsset.findUnique({
      where: { id: cursorId },
      select: { id: true, updatedAt: true, kind: true },
    });
    if (cursorRow && cursorRow.kind === kind) {
      where.OR = [
        { updatedAt: { lt: cursorRow.updatedAt } },
        { updatedAt: cursorRow.updatedAt, id: { lt: cursorRow.id } },
      ];
    }
  }

  const rows = await prisma.gkvAsset.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: filters.limit + 1,
  });

  const page = rows.slice(0, filters.limit);
  const nextCursor = rows.length > filters.limit ? (page[page.length - 1]?.id ?? null) : null;

  const assetIds = page.map((row) => row.id);
  const mappings = assetIds.length
    ? await prisma.gkvAssetCategory.findMany({
        where: { assetId: { in: assetIds } },
      })
    : [];

  const categoryIds = Array.from(new Set(mappings.map((row) => row.categoryId)));
  const categoryPathMap = await buildCategoryPaths(categoryIds);
  const categoryIdsByAsset = new Map<string, string[]>();
  const categoryPathsByAsset = new Map<string, string[]>();

  for (const mapping of mappings) {
    const ids = categoryIdsByAsset.get(mapping.assetId) ?? [];
    ids.push(mapping.categoryId);
    categoryIdsByAsset.set(mapping.assetId, ids);

    const paths = categoryPathsByAsset.get(mapping.assetId) ?? [];
    const path = categoryPathMap.get(mapping.categoryId);
    if (path) {
      paths.push(path);
      categoryPathsByAsset.set(mapping.assetId, paths);
    }
  }

  return {
    items: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      isActive: row.isActive,
      status: row.status,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes ? Number(row.sizeBytes) : null,
      durationSec: row.durationSec,
      file: {
        assetId: row.id,
        s3Bucket: row.s3Bucket,
        s3Key: row.s3Key,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes ? Number(row.sizeBytes) : null,
        status: row.status,
      },
      thumbnail: row.thumbnailKey
        ? {
            s3Bucket: row.thumbnailBucket,
            s3Key: row.thumbnailKey,
            mimeType: row.thumbnailMimeType,
            sizeBytes: row.thumbnailSizeBytes ? Number(row.thumbnailSizeBytes) : null,
            status: "READY",
          }
        : null,
      categoryIds: categoryIdsByAsset.get(row.id) ?? [],
      categoryPaths: categoryPathsByAsset.get(row.id) ?? [],
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function getScopedAsset(kind: GkvDomainKind, id: string) {
  const row = await prisma.gkvAsset.findUnique({ where: { id } });
  if (!row || row.kind !== kind) {
    return null;
  }

  const mappings = await prisma.gkvAssetCategory.findMany({ where: { assetId: id } });
  const categoryIds = mappings.map((mapping) => mapping.categoryId);
  const categoryPathMap = await buildCategoryPaths(categoryIds);

  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    description: row.description,
    isActive: row.isActive,
    status: row.status,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes ? Number(row.sizeBytes) : null,
    file: {
      assetId: row.id,
      s3Bucket: row.s3Bucket,
      s3Key: row.s3Key,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes ? Number(row.sizeBytes) : null,
      status: row.status,
    },
    thumbnail: row.thumbnailKey
      ? {
          s3Bucket: row.thumbnailBucket,
          s3Key: row.thumbnailKey,
          mimeType: row.thumbnailMimeType,
          sizeBytes: row.thumbnailSizeBytes ? Number(row.thumbnailSizeBytes) : null,
          status: "READY",
        }
      : null,
    categoryIds,
    categoryPaths: categoryIds
      .map((categoryId) => categoryPathMap.get(categoryId))
      .filter((value): value is string => Boolean(value)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertScopedCategoryIds(kind: GkvDomainKind, categoryIds: string[]) {
  const categories = await prisma.gkvCategory.findMany({
    where: { id: { in: categoryIds } },
  });
  if (categories.length !== categoryIds.length) {
    throw new Error("카테고리를 찾을 수 없습니다.");
  }
}

export async function upsertScopedAsset(
  kind: GkvDomainKind,
  payload: ScopedAssetUpsertInput,
  existingId?: string,
) {
  await assertScopedCategoryIds(kind, payload.categoryIds);

  const id = existingId ?? payload.id ?? payload.file.assetId ?? `asset_${randomUUID()}`;

  await prisma.$transaction(async (tx) => {
    if (existingId) {
      await tx.gkvAsset.update({
        where: { id },
        data: {
          kind,
          title: payload.title,
          description: payload.description ?? null,
          isActive: payload.isActive,
          s3Bucket: payload.file.s3Bucket,
          s3Key: payload.file.s3Key,
          mimeType: payload.file.mimeType,
          sizeBytes: payload.file.sizeBytes,
          status: payload.file.status,
          thumbnailBucket: payload.thumbnail?.s3Bucket ?? null,
          thumbnailKey: payload.thumbnail?.s3Key ?? null,
          thumbnailMimeType: payload.thumbnail?.mimeType ?? null,
          thumbnailSizeBytes: payload.thumbnail?.sizeBytes,
        },
      });
    } else {
      await tx.gkvAsset.create({
        data: {
          id,
          kind,
          title: payload.title,
          description: payload.description ?? null,
          isActive: payload.isActive,
          s3Bucket: payload.file.s3Bucket,
          s3Key: payload.file.s3Key,
          mimeType: payload.file.mimeType,
          sizeBytes: payload.file.sizeBytes,
          status: payload.file.status,
          thumbnailBucket: payload.thumbnail?.s3Bucket ?? null,
          thumbnailKey: payload.thumbnail?.s3Key ?? null,
          thumbnailMimeType: payload.thumbnail?.mimeType ?? null,
          thumbnailSizeBytes: payload.thumbnail?.sizeBytes,
        },
      });
    }

    await tx.gkvAssetCategory.deleteMany({ where: { assetId: id } });
    await tx.gkvAssetCategory.createMany({
      data: payload.categoryIds.map((categoryId) => ({
        assetId: id,
        categoryId,
      })),
    });
  });

  return { id };
}

export async function deleteScopedAsset(kind: GkvDomainKind, id: string) {
  const asset = await prisma.gkvAsset.findUnique({ where: { id } });
  if (!asset || asset.kind !== kind) {
    throw new Error("에셋을 찾을 수 없습니다.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.gkvAssetCategory.deleteMany({ where: { assetId: id } });
    await tx.gkvGuideAsset.deleteMany({ where: { assetId: id } });
    await tx.gkvAsset.delete({ where: { id } });
  });

  return { id, deleted: true };
}

export function resolveSlug(input: string | undefined, fallbackName: string) {
  return input && input.length > 0 ? input : slugify(fallbackName);
}
