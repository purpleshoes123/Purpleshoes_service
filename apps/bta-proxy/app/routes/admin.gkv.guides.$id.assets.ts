import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { guideAssetsConfigSchema } from "~/domains/guide-viewer/adminSchemas";
import { respond } from "~/lib/respond";
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
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    const payload = guideAssetsConfigSchema.parse(await request.json());
    const guide = await prisma.gkvGuide.findUnique({ where: { id } });
    if (!guide) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide를 찾을 수 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    if (guide.type === "PDF" && (!payload.pdfAssetId || payload.videoAssetId)) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "type=PDF는 pdfAssetId만 허용됩니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }
    if (guide.type === "VIDEO" && (!payload.videoAssetId || payload.pdfAssetId)) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "type=VIDEO는 videoAssetId만 허용됩니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.gkvGuideAsset.deleteMany({ where: { guideId: id } });
      if (payload.pdfAssetId) {
        await tx.gkvGuideAsset.create({
          data: { guideId: id, assetId: payload.pdfAssetId, role: "PDF" },
        });
      }
      if (payload.videoAssetId) {
        await tx.gkvGuideAsset.create({
          data: { guideId: id, assetId: payload.videoAssetId, role: "VIDEO" },
        });
      }
    });
    return respond.ok({ id, updated: true }, { correlationId });
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
