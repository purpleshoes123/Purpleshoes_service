import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { respond } from "~/lib/respond";

function serializeAssetForResponse(asset: {
  sizeBytes: bigint | null;
  thumbnailSizeBytes: bigint | null;
  [key: string]: unknown;
}) {
  return {
    ...asset,
    sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
    thumbnailSizeBytes:
      asset.thumbnailSizeBytes === null ? null : Number(asset.thumbnailSizeBytes),
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const categoryId = url.searchParams.get("categoryId")?.trim() || null;
  const kind = url.searchParams.get("kind")?.trim() || null;
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();

  const where: Record<string, unknown> = {
    status: "READY",
  };
  if (kind) where.kind = kind;
  if (q) where.title = { contains: q };

  const assets = await prisma.gkvAsset.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
  });

  let filtered = assets;
  if (categoryId) {
    const mappings = await prisma.gkvAssetCategory.findMany({
      where: { categoryId, assetId: { in: assets.map((a) => a.id) } },
      select: { assetId: true },
    });
    const allowed = new Set(mappings.map((m) => m.assetId));
    filtered = assets.filter((a) => allowed.has(a.id));
  }

  return respond.ok({ items: filtered.map(serializeAssetForResponse) }, { correlationId });
};
