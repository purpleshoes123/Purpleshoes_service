import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { categoryCreateSchema } from "~/lib/gkv/adminSchemas";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);

  const categories = await prisma.gkvCategory.findMany({
    orderBy: [{ depth: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const categoryIds = categories.map((c) => c.id);
  const countByCategory = new Map<string, { pdf: number; video: number }>();
  for (const id of categoryIds) {
    countByCategory.set(id, { pdf: 0, video: 0 });
  }

  if (categoryIds.length > 0) {
    const mappings = await prisma.gkvAssetCategory.findMany({
      where: { categoryId: { in: categoryIds } },
      select: { assetId: true, categoryId: true },
    });

    if (mappings.length > 0) {
      const assetIds = Array.from(new Set(mappings.map((m) => m.assetId)));
      const assets = await prisma.gkvAsset.findMany({
        where: { id: { in: assetIds }, isActive: true, status: "READY" },
        select: { id: true, kind: true },
      });
      const kindByAssetId = new Map(assets.map((a) => [a.id, a.kind]));

      for (const link of mappings) {
        const kind = kindByAssetId.get(link.assetId);
        if (!kind) continue;
        const bucket = countByCategory.get(link.categoryId);
        if (!bucket) continue;
        if (kind === "PDF") bucket.pdf += 1;
        else if (kind === "VIDEO") bucket.video += 1;
      }
    }
  }

  return respond.ok(
    {
      items: categories.map((c) => {
        const counts = countByCategory.get(c.id) ?? { pdf: 0, video: 0 };
        return {
          id: c.id,
          name: c.name,
          slug: c.slug,
          depth: c.depth,
          parentId: c.parentId,
          sortOrder: c.sortOrder,
          isActive: c.isActive,
          exposeAsGuide: c.exposeAsGuide,
          pdfAssetCount: counts.pdf,
          videoAssetCount: counts.video,
        };
      }),
    },
    { correlationId }
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);

  try {
    const payload = categoryCreateSchema.parse(await request.json());

    if (payload.depth === 1 && payload.parentId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "depth=1은 parentId를 가질 수 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    if (payload.depth > 1) {
      const parent = await prisma.gkvCategory.findUnique({ where: { id: payload.parentId ?? "" } });
      if (!parent || parent.depth !== payload.depth - 1) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            `depth=${payload.depth}는 depth=${payload.depth - 1} parentId가 필요합니다.`
          ),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId
        );
      }
    }

    const id = payload.id ?? `cat_${randomUUID()}`;
    const created = await prisma.gkvCategory.create({
      data: {
        id,
        name: payload.name,
        slug: payload.slug,
        depth: payload.depth,
        parentId: payload.parentId ?? null,
        sortOrder: payload.sortOrder,
        isActive: payload.isActive,
        exposeAsGuide: payload.exposeAsGuide,
      },
    });

    return respond.ok(
      {
        id: created.id,
      },
      { correlationId }
    );
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((i) => i.message).join(", ")
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    if (error instanceof Error && error.message.includes("Unique constraint failed")) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "slug는 고유해야 합니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
