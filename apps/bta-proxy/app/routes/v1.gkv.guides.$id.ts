import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { requireGkvCustomerId } from "~/lib/gkv/customerAuth";
import {
  pickLatestPdfAndVideoForCategory,
  toSharedCategoryIdFromGuideId,
} from "~/lib/gkv/sharedVirtualGuides.server";
import {
  canAccessGuideType,
  loadGuideExtensionEntitlements,
  resolveEntitlementExpiry,
  toGuideEntitlementType,
  toVirtualGuideType,
  VIRTUAL_GUIDE_TITLES,
} from "~/lib/gkv/v1EntitlementAccess.server";
import { resolveBundleRestaurantListId } from "~/lib/gkv/v1RestaurantAccess.server";
import { requireActiveGkvSession } from "~/lib/gkv/sessions.server";
import { respond } from "~/lib/respond";

function serializeAssetForResponse(asset: {
  sizeBytes: bigint | null;
  thumbnailSizeBytes: bigint | null;
  [key: string]: unknown;
} | null) {
  if (!asset) return null;
  return {
    ...asset,
    sizeBytes: asset.sizeBytes === null ? null : Number(asset.sizeBytes),
    thumbnailSizeBytes:
      asset.thumbnailSizeBytes === null ? null : Number(asset.thumbnailSizeBytes),
  };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) return auth;
  const correlationId = respond.getCorrelationId(request);
  const session = await requireActiveGkvSession(request, auth.customerId, correlationId);
  if (session instanceof Response) return session;
  const id = params.id;
  if (!id) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide id가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const now = new Date();
  const guideExtensionEntitlements = await loadGuideExtensionEntitlements(request, auth.customerId);

  const guide = await prisma.gkvGuide.findUnique({ where: { id } });
  if (guide && !guide.isActive) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide를 찾을 수 없습니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const sharedCategoryId = toSharedCategoryIdFromGuideId(id);
  if (sharedCategoryId !== null) {
    const sharedExpiresAt = resolveEntitlementExpiry(
      "SHARED",
      guideExtensionEntitlements,
      now
    );
    if (!sharedExpiresAt) {
      return respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
        correlationId
      );
    }

    const sharedCategory = await prisma.gkvCategory.findUnique({
      where: { id: sharedCategoryId },
    });
    if (
      !sharedCategory ||
      !sharedCategory.isActive ||
      !sharedCategory.exposeAsGuide
    ) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide를 찾을 수 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const { pdfAsset, videoAsset } =
      await pickLatestPdfAndVideoForCategory(sharedCategoryId);
    if (!pdfAsset && !videoAsset) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide를 찾을 수 없습니다."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId
      );
    }

    const sharedVirtualAssets = [];
    if (pdfAsset) {
      sharedVirtualAssets.push({ role: "PDF", asset: serializeAssetForResponse(pdfAsset) });
    }
    if (videoAsset) {
      sharedVirtualAssets.push({
        role: "VIDEO",
        asset: serializeAssetForResponse(videoAsset),
      });
    }

    return respond.ok(
      {
        id,
        title: sharedCategory.name,
        type: "SHARED",
        thumbnailUrl: null,
        expiresAt: sharedExpiresAt,
        assets: sharedVirtualAssets,
        restaurantListId: null,
      },
      { correlationId }
    );
  }

  const legacyEntitlement = await prisma.gkvEntitlement.findUnique({
    where: {
      customerId_guideId: {
        customerId: auth.customerId,
        guideId: id,
      },
    },
  });
  const isLegacyActive =
    Boolean(legacyEntitlement) &&
    legacyEntitlement?.status === "ACTIVE" &&
    legacyEntitlement.expiresAt > now;

  const virtualType = toVirtualGuideType(id);
  if (!guide && !virtualType) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "guide를 찾을 수 없습니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  if (!guide && virtualType) {
    const virtualExpiresAt = resolveEntitlementExpiry(virtualType, guideExtensionEntitlements, now);
    if (!virtualExpiresAt) {
      return respond.fail(
        ErrorCode.AUTH_LOGIN_REQUIRED,
        getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
        correlationId
      );
    }

    const newestPdfAsset = await prisma.gkvAsset.findFirst({
      where: { kind: "PDF", status: "READY", isActive: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    const newestVideoAsset = await prisma.gkvAsset.findFirst({
      where: { kind: "VIDEO", status: "READY", isActive: true },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    const bundleRestaurantListId =
      virtualType === "BUNDLE" ? await resolveBundleRestaurantListId() : null;

    const virtualAssets =
      virtualType === "PDF"
        ? [{ role: "PDF", asset: serializeAssetForResponse(newestPdfAsset) }]
        : virtualType === "VIDEO"
          ? [{ role: "VIDEO", asset: serializeAssetForResponse(newestVideoAsset) }]
          : [
              { role: "PDF", asset: serializeAssetForResponse(newestPdfAsset) },
              { role: "VIDEO", asset: serializeAssetForResponse(newestVideoAsset) },
            ];

    return respond.ok(
      {
        id,
        title: VIRTUAL_GUIDE_TITLES[virtualType],
        type: virtualType,
        thumbnailUrl: null,
        expiresAt: virtualExpiresAt,
        assets: virtualAssets,
        restaurantListId: bundleRestaurantListId,
      },
      { correlationId }
    );
  }

  const guideType = toGuideEntitlementType(guide!.type);
  const allowedByGuideExtension =
    guideType && canAccessGuideType(guideType, guideExtensionEntitlements, now);
  if (!allowedByGuideExtension && !isLegacyActive) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  const guideAssets = await prisma.gkvGuideAsset.findMany({ where: { guideId: id } });
  const assets = guideAssets.length
    ? await prisma.gkvAsset.findMany({
        where: { id: { in: guideAssets.map((a) => a.assetId) } },
      })
    : [];
  const restaurant = await prisma.gkvGuideRestaurantList.findUnique({
    where: { guideId: id },
  });
  const expiresAtByGuideExtension = guideType
    ? resolveEntitlementExpiry(guideType, guideExtensionEntitlements, now)
    : null;
  const expiresAtByLegacy = legacyEntitlement?.expiresAt?.toISOString() ?? null;

  return respond.ok(
    {
      id: guide!.id,
      title: guide!.title,
      type: guide!.type,
      thumbnailUrl: guide!.thumbnailUrl,
      expiresAt: expiresAtByGuideExtension ?? expiresAtByLegacy,
      assets: guideAssets.map((ga) => ({
        role: ga.role,
        asset: serializeAssetForResponse(assets.find((a) => a.id === ga.assetId) ?? null),
      })),
      restaurantListId: restaurant?.restaurantListId ?? null,
    },
    { correlationId }
  );
};
