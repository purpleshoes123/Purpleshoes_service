import type { ActionFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { requireGkvCustomerId } from "~/lib/gkv/customerAuth";
import { buildGkvSignedUrl } from "~/lib/gkv/signedUrl";
import {
  canAccessAssetKind,
  loadGuideExtensionEntitlements,
} from "~/lib/gkv/v1EntitlementAccess.server";
import { requireActiveGkvSession } from "~/lib/gkv/sessions.server";
import { respond } from "~/lib/respond";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) return auth;
  const correlationId = respond.getCorrelationId(request);
  const session = await requireActiveGkvSession(request, auth.customerId, correlationId);
  if (session instanceof Response) return session;
  const assetId = params.id;
  if (!assetId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const asset = await prisma.gkvAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.status !== "READY") {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "asset을 찾을 수 없거나 READY 상태가 아닙니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const now = new Date();
  const guideExtensionEntitlements = await loadGuideExtensionEntitlements(request, auth.customerId);
  const allowedByGuideExtension = canAccessAssetKind(asset.kind, guideExtensionEntitlements, now);

  const activeEntitlements = await prisma.gkvEntitlement.findMany({
    where: {
      customerId: auth.customerId,
      status: "ACTIVE",
      expiresAt: { gt: now },
    },
    select: { guideId: true },
  });
  if (!allowedByGuideExtension && activeEntitlements.length === 0) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  const allowedGuideIds = activeEntitlements.map((e) => e.guideId);
  const guideAsset =
    allowedGuideIds.length > 0
      ? await prisma.gkvGuideAsset.findFirst({
          where: {
            assetId,
            guideId: { in: allowedGuideIds },
          },
        })
      : null;
  const allowedByLegacy = Boolean(guideAsset);
  if (!allowedByGuideExtension && !allowedByLegacy) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  const signed = buildGkvSignedUrl({
    assetId,
    customerId: auth.customerId,
    s3Key: asset.s3Key,
  });

  return respond.ok(
    {
      assetId,
      signedUrl: signed.url,
      expiresAt: signed.expiresAt,
      ttlSec: signed.ttlSec,
    },
    { correlationId }
  );
};
