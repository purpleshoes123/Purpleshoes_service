import prisma from "~/db.server";
import type { GkvAsset, GkvCategory } from "@prisma/client";

export const SHARED_VIRTUAL_GUIDE_ID_PREFIX = "gkv_virtual_shared_" as const;

export function toSharedGuideIdFromCategoryId(categoryId: string): string {
  return `${SHARED_VIRTUAL_GUIDE_ID_PREFIX}${categoryId}`;
}

export function toSharedCategoryIdFromGuideId(guideId: string): string | null {
  if (!guideId.startsWith(SHARED_VIRTUAL_GUIDE_ID_PREFIX)) {
    return null;
  }
  return guideId.slice(SHARED_VIRTUAL_GUIDE_ID_PREFIX.length);
}

export async function listEligibleSharedCategories(): Promise<GkvCategory[]> {
  return prisma.gkvCategory.findMany({
    where: { isActive: true, exposeAsGuide: true },
    orderBy: [{ depth: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Mapped assets in category: latest READY PDF and latest READY VIDEO by updatedAt, then createdAt.
 */
export async function pickLatestPdfAndVideoForCategory(
  categoryId: string
): Promise<{ pdfAsset: GkvAsset | null; videoAsset: GkvAsset | null }> {
  const mappings = await prisma.gkvAssetCategory.findMany({
    where: { categoryId },
    select: { assetId: true },
  });
  if (mappings.length === 0) {
    return { pdfAsset: null, videoAsset: null };
  }

  const assetIds = mappings.map((m) => m.assetId);

  const [pdfAsset, videoAsset] = await Promise.all([
    prisma.gkvAsset.findFirst({
      where: {
        id: { in: assetIds },
        kind: "PDF",
        status: "READY",
        isActive: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
    prisma.gkvAsset.findFirst({
      where: {
        id: { in: assetIds },
        kind: "VIDEO",
        status: "READY",
        isActive: true,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    }),
  ]);

  return {
    pdfAsset: pdfAsset ?? null,
    videoAsset: videoAsset ?? null,
  };
}
