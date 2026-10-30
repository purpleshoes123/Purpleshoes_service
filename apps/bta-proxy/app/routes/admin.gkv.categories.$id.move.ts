import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { categoryMoveSchema } from "~/domains/guide-viewer/adminSchemas";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);
  const id = params.id;

  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "category id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  if (request.method !== "POST") {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    const payload = categoryMoveSchema.parse(await request.json());

    const current = await prisma.gkvCategory.findUnique({ where: { id } });
    if (!current) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "카테고리를 찾을 수 없습니다."),
        undefined,
        404,
        correlationId,
      );
    }

    const siblings = (
      await prisma.gkvCategory.findMany({
        where: { parentId: current.parentId, depth: current.depth },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      })
    ).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      const nameOrder = a.name.localeCompare(b.name);
      if (nameOrder !== 0) {
        return nameOrder;
      }
      return a.id.localeCompare(b.id);
    });

    const currentIdx = siblings.findIndex((s) => s.id === current.id);
    const neighborIdx = payload.direction === "up" ? currentIdx - 1 : currentIdx + 1;

    if (currentIdx < 0 || neighborIdx < 0 || neighborIdx >= siblings.length) {
      return respond.ok({ id: current.id, swappedWith: null }, { correlationId });
    }

    const neighbor = siblings[neighborIdx];
    const reordered = [...siblings];
    reordered.splice(currentIdx, 1);
    reordered.splice(neighborIdx, 0, current);
    const desiredOrders = reordered.map((sibling, index) => ({
      id: sibling.id,
      sortOrder: (index + 1) * 10,
    }));

    await prisma.$transaction(async (tx) => {
      for (const item of desiredOrders) {
        if (siblings.find((s) => s.id === item.id)?.sortOrder === item.sortOrder) {
          continue;
        }
        await tx.gkvCategory.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        });
      }
    });

    return respond.ok({ id: current.id, swappedWith: neighbor.id }, { correlationId });
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const zodError = error as { issues: Array<{ message: string }> };
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(
          ErrorCode.VALIDATION_ERROR,
          zodError.issues.map((i) => i.message).join(", "),
        ),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};
