import { randomUUID } from "crypto";
import prisma from "~/db.server";
import { parseJsonArray, slugify, type GkvMeatType } from "~/lib/gkv/adminUiSchemas";
import {
  buildRestaurantPhotoUrls,
  serializeRestaurantPhotoMeta,
  toRestaurantPhotoData,
  type RestaurantPhotoMeta,
} from "~/lib/gkv/restaurantPhotoUrls.server";

export type RestaurantCategoryInput = {
  id?: string;
  name: string;
  slug?: string;
  sortOrder: number;
  isActive: boolean;
};

export type AreaInput = RestaurantCategoryInput;

export type RestaurantUpsertInput = {
  id?: string;
  name: string;
  areaId: string;
  categoryIds: string[];
  veganRecommended: boolean;
  meatTypes: GkvMeatType[];
  address: string;
  lat: number;
  lng: number;
  kakaoPlaceId?: string;
  naverPlaceUrl?: string | null;
  tags?: string[];
  memo?: string;
  priority: number;
  isActive: boolean;
  photo?: RestaurantPhotoMeta | null;
};

function resolveSlug(input: string | undefined, name: string) {
  const normalized = input && input.trim().length > 0 ? input.trim() : slugify(name);
  return normalized;
}

export async function listRestaurantCategories(includeInactive: boolean) {
  const rows = await prisma.gkvRestaurantCategory.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function upsertRestaurantCategory(input: RestaurantCategoryInput, existingId?: string) {
  const id = existingId ?? input.id ?? `rc_${randomUUID()}`;
  if (existingId) {
    await prisma.gkvRestaurantCategory.update({
      where: { id },
      data: {
        name: input.name,
        slug: resolveSlug(input.slug, input.name),
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
  } else {
    await prisma.gkvRestaurantCategory.create({
      data: {
        id,
        name: input.name,
        slug: resolveSlug(input.slug, input.name),
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
  }
  return { id };
}

export async function deleteRestaurantCategory(id: string) {
  await prisma.$transaction(async (tx) => {
    await tx.gkvRestaurantCategoryMap.deleteMany({ where: { categoryId: id } });
    await tx.gkvRestaurantCategory.delete({ where: { id } });
  });
  return { id, deleted: true };
}

export async function listAreas(includeInactive: boolean) {
  const rows = await prisma.gkvArea.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

export async function upsertArea(input: AreaInput, existingId?: string) {
  const id = existingId ?? input.id ?? `area_${randomUUID()}`;
  if (existingId) {
    await prisma.gkvArea.update({
      where: { id },
      data: {
        name: input.name,
        slug: resolveSlug(input.slug, input.name),
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
  } else {
    await prisma.gkvArea.create({
      data: {
        id,
        name: input.name,
        slug: resolveSlug(input.slug, input.name),
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
  }
  return { id };
}

export async function deleteArea(id: string) {
  await prisma.gkvArea.delete({ where: { id } });
  return { id, deleted: true };
}

export async function listRestaurants(filters: {
  q?: string;
  categoryIds?: string[];
  areaId?: string;
  veganRecommended?: boolean;
  meatTypes?: GkvMeatType[];
  isActive?: boolean;
  sort: "priority" | "newest" | "name";
  limit: number;
  page: number;
  cursor?: string;
}) {
  const where: Record<string, unknown> = {
    ...(filters.areaId ? { areaId: filters.areaId } : {}),
    ...(filters.veganRecommended !== undefined
      ? { veganRecommended: filters.veganRecommended }
      : {}),
    ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    ...(filters.q
      ? {
          OR: [
            { name: { contains: filters.q } },
            { address: { contains: filters.q } },
          ],
        }
      : {}),
  };

  const rows = await prisma.gkvRestaurant.findMany({ where });

  const mappings = rows.length
    ? await prisma.gkvRestaurantCategoryMap.findMany({
        where: { restaurantId: { in: rows.map((row) => row.id) } },
      })
    : [];

  const categoryIdsByRestaurant = new Map<string, string[]>();
  for (const mapping of mappings) {
    const ids = categoryIdsByRestaurant.get(mapping.restaurantId) ?? [];
    ids.push(mapping.categoryId);
    categoryIdsByRestaurant.set(mapping.restaurantId, ids);
  }

  let filtered = rows.filter((row) => {
    const rowCategoryIds = categoryIdsByRestaurant.get(row.id) ?? [];
    if (filters.categoryIds && filters.categoryIds.length > 0) {
      const hasAny = filters.categoryIds.some((categoryId) => rowCategoryIds.includes(categoryId));
      if (!hasAny) return false;
    }

    if (filters.meatTypes && filters.meatTypes.length > 0) {
      const meats = parseJsonArray(row.meatTypes);
      const hasAny = filters.meatTypes.some((meatType) => meats.includes(meatType));
      if (!hasAny) return false;
    }

    return true;
  });

  const sorters: Record<typeof filters.sort, (a: (typeof filtered)[number], b: (typeof filtered)[number]) => number> = {
    priority: (a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    },
    newest: (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    name: (a, b) => a.name.localeCompare(b.name),
  };

  filtered = filtered.sort(sorters[filters.sort]);

  const totalCount = filtered.length;
  let startIndex = Math.max(filters.page - 1, 0) * filters.limit;

  if (filters.cursor) {
    const cursorIndex = filtered.findIndex((row) => row.id === filters.cursor);
    if (cursorIndex >= 0) {
      startIndex = cursorIndex + 1;
    }
  }

  const page = filtered.slice(startIndex, startIndex + filters.limit);
  const hasPreviousPage = startIndex > 0;
  const hasNextPage = startIndex + page.length < totalCount;
  const nextCursor = hasNextPage ? page[page.length - 1]?.id ?? null : null;

  const pageAreaIds = Array.from(new Set(page.map((row) => row.areaId)));
  const areaRows = pageAreaIds.length
    ? await prisma.gkvArea.findMany({ where: { id: { in: pageAreaIds } } })
    : [];
  const areaById = new Map(areaRows.map((row) => [row.id, row]));

  const pageRestaurantIds = page.map((row) => row.id);
  const pageMappings = pageRestaurantIds.length
    ? await prisma.gkvRestaurantCategoryMap.findMany({
        where: { restaurantId: { in: pageRestaurantIds } },
      })
    : [];
  const pageCategoryIds = Array.from(new Set(pageMappings.map((row) => row.categoryId)));
  const categoryRows = pageCategoryIds.length
    ? await prisma.gkvRestaurantCategory.findMany({ where: { id: { in: pageCategoryIds } } })
    : [];
  const categoryById = new Map(categoryRows.map((row) => [row.id, row]));

  const categoriesByRestaurant = new Map<string, Array<{ id: string; name: string; slug: string }>>();
  for (const mapping of pageMappings) {
    const category = categoryById.get(mapping.categoryId);
    if (!category) continue;
    const list = categoriesByRestaurant.get(mapping.restaurantId) ?? [];
    list.push({ id: category.id, name: category.name, slug: category.slug });
    categoriesByRestaurant.set(mapping.restaurantId, list);
  }

  return {
    items: page.map((row) => {
      const area = areaById.get(row.areaId);
      return {
        id: row.id,
        name: row.name,
        areaId: row.areaId,
        area: area
          ? {
              id: area.id,
              name: area.name,
              slug: area.slug,
            }
          : null,
        categoryIds: (categoriesByRestaurant.get(row.id) ?? []).map((category) => category.id),
        categories: categoriesByRestaurant.get(row.id) ?? [],
        veganRecommended: row.veganRecommended,
        meatTypes: parseJsonArray(row.meatTypes),
        address: row.address,
        lat: row.lat,
        lng: row.lng,
        kakaoPlaceId: row.kakaoPlaceId,
        naverPlaceUrl: row.naverPlaceUrl,
        tags: parseJsonArray(row.tags),
        memo: row.memo,
        priority: row.priority,
        isActive: row.isActive,
        photo: serializeRestaurantPhotoMeta(row),
        ...buildRestaurantPhotoUrls(row.id, row, "admin"),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    totalCount,
    page: filters.page,
    pageSize: filters.limit,
    hasPreviousPage,
    hasNextPage,
    nextCursor,
  };
}

export async function getRestaurant(id: string) {
  const row = await prisma.gkvRestaurant.findUnique({ where: { id } });
  if (!row) return null;

  const area = await prisma.gkvArea.findUnique({ where: { id: row.areaId } });
  const mappings = await prisma.gkvRestaurantCategoryMap.findMany({ where: { restaurantId: id } });
  const categoryRows = mappings.length
    ? await prisma.gkvRestaurantCategory.findMany({
        where: { id: { in: mappings.map((mapping) => mapping.categoryId) } },
      })
    : [];

  return {
    id: row.id,
    name: row.name,
    areaId: row.areaId,
    area: area ? { id: area.id, name: area.name, slug: area.slug } : null,
    categoryIds: mappings.map((mapping) => mapping.categoryId),
    categories: categoryRows.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
    })),
    veganRecommended: row.veganRecommended,
    meatTypes: parseJsonArray(row.meatTypes),
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    kakaoPlaceId: row.kakaoPlaceId,
    naverPlaceUrl: row.naverPlaceUrl,
    tags: parseJsonArray(row.tags),
    memo: row.memo,
    priority: row.priority,
    isActive: row.isActive,
    photo: serializeRestaurantPhotoMeta(row),
    ...buildRestaurantPhotoUrls(row.id, row, "admin"),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertRestaurant(input: RestaurantUpsertInput, existingId?: string) {
  const area = await prisma.gkvArea.findUnique({ where: { id: input.areaId } });
  if (!area) {
    throw new Error("선택한 Area를 찾을 수 없습니다.");
  }

  const categories = await prisma.gkvRestaurantCategory.findMany({
    where: { id: { in: input.categoryIds } },
  });
  if (categories.length !== input.categoryIds.length) {
    throw new Error("선택한 카테고리를 찾을 수 없습니다.");
  }

  const id = existingId ?? input.id ?? `rest_${randomUUID()}`;

  await prisma.$transaction(async (tx) => {
    if (existingId) {
      await tx.gkvRestaurant.update({
        where: { id },
        data: {
          name: input.name,
          areaId: input.areaId,
          address: input.address,
          lat: input.lat,
          lng: input.lng,
          kakaoPlaceId: input.kakaoPlaceId,
          naverPlaceUrl: input.naverPlaceUrl === undefined ? undefined : input.naverPlaceUrl || null,
          tags: input.tags ? JSON.stringify(input.tags) : null,
          memo: input.memo ?? null,
          priority: input.priority,
          isActive: input.isActive,
          veganRecommended: input.veganRecommended,
          meatTypes: JSON.stringify(input.meatTypes),
          ...(input.photo !== undefined ? toRestaurantPhotoData(input.photo) : {}),
        },
      });
    } else {
      await tx.gkvRestaurant.create({
        data: {
          id,
          name: input.name,
          areaId: input.areaId,
          address: input.address,
          lat: input.lat,
          lng: input.lng,
          kakaoPlaceId: input.kakaoPlaceId,
          naverPlaceUrl: input.naverPlaceUrl || null,
          tags: input.tags ? JSON.stringify(input.tags) : null,
          memo: input.memo ?? null,
          priority: input.priority,
          isActive: input.isActive,
          veganRecommended: input.veganRecommended,
          meatTypes: JSON.stringify(input.meatTypes),
          ...(input.photo !== undefined ? toRestaurantPhotoData(input.photo) : {}),
        },
      });
    }

    await tx.gkvRestaurantCategoryMap.deleteMany({ where: { restaurantId: id } });
    await tx.gkvRestaurantCategoryMap.createMany({
      data: input.categoryIds.map((categoryId) => ({
        restaurantId: id,
        categoryId,
      })),
    });
  });

  return { id };
}

export async function deactivateRestaurant(id: string) {
  await prisma.gkvRestaurant.update({
    where: { id },
    data: {
      isActive: false,
    },
  });
  return { id, deleted: true };
}
