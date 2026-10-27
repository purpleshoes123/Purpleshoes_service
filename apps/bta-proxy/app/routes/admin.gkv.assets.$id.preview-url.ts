import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { buildGkvSignedUrl } from "~/lib/gkv/signedUrl";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

type PreviewAssetKind = "PDF" | "VIDEO";

const ADMIN_PREVIEW_CUSTOMER_ID = "admin-preview";

function isPreviewAssetKind(kind: string): kind is PreviewAssetKind {
  return kind === "PDF" || kind === "VIDEO";
}

function logPreviewEvent(payload: Record<string, unknown>) {
  console.log(JSON.stringify(payload));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);
  const id = params.id;
  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const asset = await prisma.gkvAsset.findUnique({ where: { id } });
  if (!asset) {
    logPreviewEvent({
      message: "GKV admin asset preview URL denied",
      assetId: id,
      reason: "ASSET_NOT_FOUND",
      correlationId,
    });
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset을 찾을 수 없습니다."),
      undefined,
      404,
      correlationId
    );
  }

  if (!isPreviewAssetKind(asset.kind)) {
    logPreviewEvent({
      message: "GKV admin asset preview URL denied",
      assetId: asset.id,
      kind: asset.kind,
      reason: "UNSUPPORTED_ASSET_KIND",
      correlationId,
    });
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "PDF/VIDEO asset만 열람할 수 있습니다."),
      undefined,
      422,
      correlationId
    );
  }

  if (asset.status !== "READY") {
    logPreviewEvent({
      message: "GKV admin asset preview URL denied",
      assetId: asset.id,
      kind: asset.kind,
      status: asset.status,
      reason: "ASSET_NOT_READY",
      correlationId,
    });
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "READY 상태 파일만 열람할 수 있습니다."),
      undefined,
      422,
      correlationId
    );
  }

  if (!asset.isActive) {
    logPreviewEvent({
      message: "GKV admin asset preview URL denied",
      assetId: asset.id,
      kind: asset.kind,
      status: asset.status,
      isActive: asset.isActive,
      reason: "ASSET_INACTIVE",
      correlationId,
    });
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "활성 파일만 열람할 수 있습니다."),
      undefined,
      422,
      correlationId
    );
  }

  const signed = buildGkvSignedUrl({
    assetId: asset.id,
    customerId: ADMIN_PREVIEW_CUSTOMER_ID,
    s3Key: asset.s3Key,
  });

  logPreviewEvent({
    message: "GKV admin asset preview URL issued",
    assetId: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    status: asset.status,
    isActive: asset.isActive,
    ttlSec: signed.ttlSec,
    correlationId,
  });

  return respond.ok(
    {
      assetId: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      previewUrl: signed.url,
      expiresAt: signed.expiresAt,
      ttlSec: signed.ttlSec,
    },
    { correlationId }
  );
};
