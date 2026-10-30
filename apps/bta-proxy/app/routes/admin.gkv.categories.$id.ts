import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { categoryUpdateSchema } from "~/domains/guide-viewer/adminSchemas";
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

  try {
    if (request.method === "DELETE") {
      await prisma.gkvCategory.delete({ where: { id } });
      return respond.ok({ id, deleted: true }, { correlationId });
    }

    if (request.method !== "PUT") {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 메서드입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    const payload = categoryUpdateSchema.parse(await request.json());
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

    const wantsReparent = payload.parentId !== undefined && payload.parentId !== current.parentId;
    const nextParentId = payload.parentId !== undefined ? payload.parentId : current.parentId;

    // depth는 parent에서 권위적으로 산출 (운영자가 명시한 depth는 reparent 시 무시)
    let nextDepth: 1 | 2 | 3 = current.depth as 1 | 2 | 3;
    if (wantsReparent) {
      if (nextParentId) {
        const parent = await prisma.gkvCategory.findUnique({ where: { id: nextParentId } });
        if (!parent) {
          return respond.fail(
            ErrorCode.VALIDATION_ERROR,
            getErrorMessage(ErrorCode.VALIDATION_ERROR, "상위 카테고리를 찾을 수 없습니다."),
            undefined,
            getErrorStatus(ErrorCode.VALIDATION_ERROR),
            correlationId,
          );
        }
        nextDepth = (parent.depth + 1) as 1 | 2 | 3;
      } else {
        nextDepth = 1;
      }
      if (nextDepth < 1 || nextDepth > 3) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "depth는 1~3 범위여야 합니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }
    } else if (payload.depth !== undefined) {
      nextDepth = payload.depth;
    }

    if (![1, 2, 3].includes(nextDepth)) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "지원하지 않는 depth입니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    if (nextDepth === 1 && nextParentId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "depth=1은 parentId를 가질 수 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    if (nextDepth > 1) {
      const parent = await prisma.gkvCategory.findUnique({ where: { id: nextParentId ?? "" } });
      if (!parent || parent.depth !== nextDepth - 1) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            `depth=${nextDepth}는 depth=${nextDepth - 1} parentId가 필요합니다.`,
          ),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }
    }

    let descendantCascade: { id: string; nextDepth: number }[] = [];
    let nextSortOrder: number | undefined =
      payload.sortOrder !== undefined ? payload.sortOrder : undefined;

    if (wantsReparent) {
      // 자기 자신 또는 자손으로 이동 차단
      if (nextParentId === current.id) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "자기 자신을 상위로 지정할 수 없습니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }

      const allCategories = await prisma.gkvCategory.findMany({
        select: { id: true, parentId: true, depth: true, sortOrder: true },
      });
      const childrenByParent = new Map<string | null, typeof allCategories>();
      for (const cat of allCategories) {
        const list = childrenByParent.get(cat.parentId) ?? [];
        list.push(cat);
        childrenByParent.set(cat.parentId, list);
      }

      const collectDescendants = (rootId: string): typeof allCategories => {
        const result: typeof allCategories = [];
        const stack: string[] = [rootId];
        while (stack.length > 0) {
          const top = stack.pop()!;
          const children = childrenByParent.get(top) ?? [];
          for (const child of children) {
            result.push(child);
            stack.push(child.id);
          }
        }
        return result;
      };

      const descendants = collectDescendants(current.id);
      const descendantIds = new Set(descendants.map((d) => d.id));
      if (nextParentId && descendantIds.has(nextParentId)) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "자손을 상위로 지정할 수 없습니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }

      const depthDelta = nextDepth - current.depth;
      if (depthDelta !== 0 && descendants.length > 0) {
        for (const d of descendants) {
          const newD = d.depth + depthDelta;
          if (newD < 1 || newD > 3) {
            return respond.fail(
              ErrorCode.VALIDATION_ERROR,
              getErrorMessage(
                ErrorCode.VALIDATION_ERROR,
                `이동 시 자손 카테고리의 depth가 1~3 범위를 벗어납니다 (예상 depth=${newD}).`,
              ),
              undefined,
              getErrorStatus(ErrorCode.VALIDATION_ERROR),
              correlationId,
            );
          }
          descendantCascade.push({ id: d.id, nextDepth: newD });
        }
      }

      if (nextSortOrder === undefined) {
        const newSiblings = (childrenByParent.get(nextParentId) ?? []).filter(
          (s) => s.id !== current.id,
        );
        const maxSibling = newSiblings.reduce(
          (acc, s) => (s.sortOrder > acc ? s.sortOrder : acc),
          -10,
        );
        nextSortOrder = maxSibling + 10;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.gkvCategory.update({
        where: { id },
        data: {
          ...(payload.name !== undefined ? { name: payload.name } : {}),
          ...(payload.slug !== undefined ? { slug: payload.slug } : {}),
          ...(wantsReparent || payload.depth !== undefined ? { depth: nextDepth } : {}),
          ...(payload.parentId !== undefined ? { parentId: payload.parentId } : {}),
          ...(nextSortOrder !== undefined ? { sortOrder: nextSortOrder } : {}),
          ...(payload.isActive !== undefined ? { isActive: payload.isActive } : {}),
          ...(payload.exposeAsGuide !== undefined ? { exposeAsGuide: payload.exposeAsGuide } : {}),
        },
      });

      for (const cascade of descendantCascade) {
        await tx.gkvCategory.update({
          where: { id: cascade.id },
          data: { depth: cascade.nextDepth },
        });
      }
    });

    return respond.ok(
      {
        id,
        updated: true,
        ...(wantsReparent
          ? { newDepth: nextDepth, cascadedDescendants: descendantCascade.length }
          : {}),
      },
      { correlationId },
    );
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
