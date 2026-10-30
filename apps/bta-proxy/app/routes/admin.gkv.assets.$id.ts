import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { serializeGkvAssetForJson } from "~/domains/guide-viewer/assetResponse.server.ts";
import { assetUpdateSchema } from "~/domains/guide-viewer/adminSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }
  const correlationId = respond.getCorrelationId(request);
  const id = params.id;
  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  const item = await prisma.gkvAsset.findUnique({ where: { id } });
  if (!item) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset을 찾을 수 없습니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }
  return respond.ok({ item: serializeGkvAssetForJson(item) }, { correlationId });
};

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
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    if (request.method === "DELETE") {
      await prisma.$transaction(async (tx) => {
        await tx.gkvAssetCategory.deleteMany({ where: { assetId: id } });
        await tx.gkvGuideAsset.deleteMany({ where: { assetId: id } });
        await tx.gkvAsset.delete({ where: { id } });
      });
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

    const payload = assetUpdateSchema.parse(await request.json());
    await prisma.gkvAsset.update({
      where: { id },
      data: {
        ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
        ...(payload.title !== undefined ? { title: payload.title } : {}),
        ...(payload.s3Bucket !== undefined ? { s3Bucket: payload.s3Bucket } : {}),
        ...(payload.s3Key !== undefined ? { s3Key: payload.s3Key } : {}),
        ...(payload.mimeType !== undefined ? { mimeType: payload.mimeType } : {}),
        ...(payload.sizeBytes !== undefined ? { sizeBytes: payload.sizeBytes } : {}),
        ...(payload.checksumSha256 !== undefined ? { checksumSha256: payload.checksumSha256 } : {}),
        ...(payload.durationSec !== undefined ? { durationSec: payload.durationSec } : {}),
        ...(payload.status !== undefined ? { status: payload.status } : {}),
      },
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
