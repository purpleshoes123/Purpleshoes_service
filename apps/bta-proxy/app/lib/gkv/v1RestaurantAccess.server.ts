import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { requireActiveGkvSession } from "~/lib/gkv/sessions.server";
import { canAccessGuideType, loadGuideExtensionEntitlements } from "~/lib/gkv/v1EntitlementAccess.server";
import { respond } from "~/lib/respond";

export const VIRTUAL_BUNDLE_RESTAURANT_LIST_ID = "gkv_virtual_restaurants";

export async function resolveBundleRestaurantListId(): Promise<string | null> {
  const hasVirtualRestaurants = await prisma.gkvRestaurant.findFirst({
    where: { isActive: true },
    select: { id: true },
  });
  if (hasVirtualRestaurants) {
    return VIRTUAL_BUNDLE_RESTAURANT_LIST_ID;
  }

  const legacyList = await prisma.gkvRestaurantList.findFirst({
    where: { isActive: true },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  return legacyList?.id ?? null;
}

export async function canAccessVirtualBundleRestaurants(
  request: Request,
  customerId: string
): Promise<boolean> {
  const now = new Date();
  const guideExtensionEntitlements = await loadGuideExtensionEntitlements(request, customerId);
  if (canAccessGuideType("BUNDLE", guideExtensionEntitlements, now)) {
    return true;
  }

  const legacyEntitlements = await prisma.gkvEntitlement.findMany({
    where: {
      customerId,
      status: "ACTIVE",
      expiresAt: { gt: now },
    },
    select: { guideId: true },
  });
  if (legacyEntitlements.length === 0) {
    return false;
  }

  const bundleGuide = await prisma.gkvGuide.findFirst({
    where: {
      id: { in: legacyEntitlements.map((item) => item.guideId) },
      type: "BUNDLE",
      isActive: true,
    },
    select: { id: true },
  });
  return Boolean(bundleGuide);
}

export async function loadAccessibleBundleRestaurantListIds(
  request: Request,
  customerId: string,
  now = new Date()
): Promise<Set<string>> {
  const accessibleIds = new Set<string>();
  const guideExtensionEntitlements = await loadGuideExtensionEntitlements(request, customerId);
  const hasGuideExtensionBundle = canAccessGuideType("BUNDLE", guideExtensionEntitlements, now);

  if (hasGuideExtensionBundle) {
    const resolvedBundleListId = await resolveBundleRestaurantListId();
    if (resolvedBundleListId) {
      accessibleIds.add(resolvedBundleListId);
    }

    const activeBundleGuides = await prisma.gkvGuide.findMany({
      where: { type: "BUNDLE", isActive: true },
      select: { id: true },
    });
    const bundleGuideIds = activeBundleGuides.map((guide) => guide.id);
    if (bundleGuideIds.length > 0) {
      const links = await prisma.gkvGuideRestaurantList.findMany({
        where: { guideId: { in: bundleGuideIds } },
        select: { restaurantListId: true },
      });
      for (const link of links) {
        accessibleIds.add(link.restaurantListId);
      }
    }
  }

  const legacyEntitlements = await prisma.gkvEntitlement.findMany({
    where: {
      customerId,
      status: "ACTIVE",
      expiresAt: { gt: now },
    },
    select: { guideId: true },
  });
  const legacyGuideIds = legacyEntitlements.map((item) => item.guideId);
  if (legacyGuideIds.length === 0) {
    return accessibleIds;
  }

  const legacyBundleGuides = await prisma.gkvGuide.findMany({
    where: {
      id: { in: legacyGuideIds },
      type: "BUNDLE",
      isActive: true,
    },
    select: { id: true },
  });
  const legacyBundleGuideIds = legacyBundleGuides.map((guide) => guide.id);
  if (legacyBundleGuideIds.length === 0) {
    return accessibleIds;
  }

  accessibleIds.add(VIRTUAL_BUNDLE_RESTAURANT_LIST_ID);

  const legacyLinks = await prisma.gkvGuideRestaurantList.findMany({
    where: { guideId: { in: legacyBundleGuideIds } },
    select: { restaurantListId: true },
  });
  for (const link of legacyLinks) {
    accessibleIds.add(link.restaurantListId);
  }

  return accessibleIds;
}

export async function canAccessBundleRestaurantList(
  request: Request,
  customerId: string,
  listId: string,
  now = new Date()
): Promise<boolean> {
  const accessibleIds = await loadAccessibleBundleRestaurantListIds(request, customerId, now);
  return accessibleIds.has(listId);
}

export async function requireV1BundleRestaurantListAccess(params: {
  request: Request;
  customerId: string;
  listId: string;
  correlationId?: string;
}): Promise<{ customerId: string } | Response> {
  const correlationId = params.correlationId ?? respond.getCorrelationId(params.request);
  const session = await requireActiveGkvSession(
    params.request,
    params.customerId,
    correlationId
  );
  if (session instanceof Response) return session;

  const allowed = await canAccessBundleRestaurantList(
    params.request,
    params.customerId,
    params.listId
  );
  if (!allowed) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  return { customerId: params.customerId };
}
