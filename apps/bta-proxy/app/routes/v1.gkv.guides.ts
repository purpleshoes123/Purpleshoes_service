import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { requireGkvCustomerId } from "~/lib/gkv/customerAuth";
import {
  listEligibleSharedCategories,
  pickLatestPdfAndVideoForCategory,
  toSharedGuideIdFromCategoryId,
} from "~/lib/gkv/sharedVirtualGuides.server";
import {
  canAccessGuideType,
  loadGuideExtensionEntitlements,
  resolveEntitlementExpiry,
  toGuideEntitlementType,
  VIRTUAL_GUIDE_IDS,
  VIRTUAL_GUIDE_TITLES,
} from "~/lib/gkv/v1EntitlementAccess.server";
import { requireActiveGkvSession } from "~/lib/gkv/sessions.server";
import { respond } from "~/lib/respond";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) return auth;
  const includeExpired = new URL(request.url).searchParams.get("includeExpired") === "true";
  const correlationId = respond.getCorrelationId(request);
  const session = await requireActiveGkvSession(request, auth.customerId, correlationId);
  if (session instanceof Response) return session;
  const now = new Date();
  const guideExtensionEntitlements = await loadGuideExtensionEntitlements(request, auth.customerId);

  const entitlements = await prisma.gkvEntitlement.findMany({
    where: {
      customerId: auth.customerId,
      status: "ACTIVE",
      ...(includeExpired ? {} : { expiresAt: { gt: now } }),
    },
    select: { guideId: true, expiresAt: true },
  });
  const guideIds = entitlements.map((e) => e.guideId);
  const guideIdSet = new Set(guideIds);
  const expiresByGuide = new Map(entitlements.map((e) => [e.guideId, e.expiresAt]));

  const guides = await prisma.gkvGuide.findMany({
    where: { isActive: true },
    orderBy: [{ updatedAt: "desc" }],
  });

  const items = guides
    .filter((guide) => {
      const type = toGuideEntitlementType(guide.type);
      const allowedByGuideExtension =
        type && canAccessGuideType(type, guideExtensionEntitlements, now);
      const allowedByLegacy = guideIdSet.has(guide.id);
      return Boolean(allowedByGuideExtension || allowedByLegacy);
    })
    .map((guide) => {
      const type = toGuideEntitlementType(guide.type);
      const expiresAtByGuideExtension = type
        ? resolveEntitlementExpiry(type, guideExtensionEntitlements, now)
        : null;
      const expiresAtByLegacy = expiresByGuide.get(guide.id)?.toISOString() ?? null;
      return {
        id: guide.id,
        title: guide.title,
        type: guide.type,
        thumbnailUrl: guide.thumbnailUrl,
        expiresAt: expiresAtByGuideExtension ?? expiresAtByLegacy,
      };
    });

  const representedTypes = new Set(
    items
      .map((item) => toGuideEntitlementType(item.type))
      .filter(
        (type): type is "PDF" | "VIDEO" | "BUNDLE" =>
          type === "PDF" || type === "VIDEO" || type === "BUNDLE"
      )
  );
  const virtualTypes = [
    { type: "BUNDLE" as const, id: VIRTUAL_GUIDE_IDS.BUNDLE, title: VIRTUAL_GUIDE_TITLES.BUNDLE },
    { type: "PDF" as const, id: VIRTUAL_GUIDE_IDS.PDF, title: VIRTUAL_GUIDE_TITLES.PDF },
    { type: "VIDEO" as const, id: VIRTUAL_GUIDE_IDS.VIDEO, title: VIRTUAL_GUIDE_TITLES.VIDEO },
  ];

  virtualTypes.forEach((virtual) => {
    if (representedTypes.has(virtual.type)) return;
    const expiresAt = resolveEntitlementExpiry(virtual.type, guideExtensionEntitlements, now);
    if (!expiresAt) return;
    items.push({
      id: virtual.id,
      title: virtual.title,
      type: virtual.type,
      thumbnailUrl: null,
      expiresAt,
    });
  });

  const sharedExpiresAt = resolveEntitlementExpiry(
    "SHARED",
    guideExtensionEntitlements,
    now
  );
  if (sharedExpiresAt) {
    const sharedCategories = await listEligibleSharedCategories();
    for (const cat of sharedCategories) {
      const { pdfAsset, videoAsset } = await pickLatestPdfAndVideoForCategory(cat.id);
      if (!pdfAsset && !videoAsset) continue;
      items.push({
        id: toSharedGuideIdFromCategoryId(cat.id),
        title: cat.name,
        type: "SHARED",
        thumbnailUrl: null,
        expiresAt: sharedExpiresAt,
      });
    }
  }

  return respond.ok(
    {
      items,
    },
    { correlationId }
  );
};
