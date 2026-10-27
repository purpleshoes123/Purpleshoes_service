import type { ActionFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { requireGkvCustomerId } from "~/lib/gkv/customerAuth";
import { resolveGuideSessionLimit } from "~/lib/gkv/entitlementLimits";
import { listActiveGkvSessions } from "~/lib/gkv/sessions.server";
import { loadGuideExtensionEntitlements } from "~/lib/gkv/v1EntitlementAccess.server";
import { respond } from "~/lib/respond";
import { z } from "zod";

const schema = z.object({
  deviceId: z.string().trim().min(1),
  deviceName: z.string().trim().optional(),
  platform: z.enum(["ios", "android"]).optional(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) return auth;
  const correlationId = respond.getCorrelationId(request);

  try {
    const payload = schema.parse(await request.json());
    const guideEntitlements = await loadGuideExtensionEntitlements(
      request,
      auth.customerId
    );
    const max = resolveGuideSessionLimit(guideEntitlements, new Date());

    await prisma.gkvCustomer.upsert({
      where: { customerId: auth.customerId },
      create: { customerId: auth.customerId },
      update: {},
    });
    await prisma.gkvDevice.upsert({
      where: {
        customerId_deviceId: {
          customerId: auth.customerId,
          deviceId: payload.deviceId,
        },
      },
      create: {
        customerId: auth.customerId,
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        platform: payload.platform,
      },
      update: {
        deviceName: payload.deviceName,
        platform: payload.platform,
        lastSeenAt: new Date(),
      },
    });

    const active = await prisma.gkvSession.findMany({
      where: { customerId: auth.customerId, revokedAt: null },
      orderBy: [{ createdAt: "asc" }],
    });
    const existing = active.find((s) => s.deviceId === payload.deviceId);
    if (existing) {
      return respond.ok(
        { sessionId: existing.id, reused: true, activeCount: active.length, maxActive: max },
        { correlationId }
      );
    }
    if (active.length >= max) {
      const activeSessions = await listActiveGkvSessions(auth.customerId);
      return respond.fail(
        ErrorCode.GKV_SESSION_LIMIT_EXCEEDED,
        getErrorMessage(ErrorCode.GKV_SESSION_LIMIT_EXCEEDED),
        { activeCount: active.length, maxActive: max, activeSessions },
        getErrorStatus(ErrorCode.GKV_SESSION_LIMIT_EXCEEDED),
        correlationId
      );
    }

    const created = await prisma.gkvSession.create({
      data: {
        id: `sess_${randomUUID()}`,
        customerId: auth.customerId,
        deviceId: payload.deviceId,
      },
    });

    return respond.ok(
      { sessionId: created.id, reused: false, activeCount: active.length + 1, maxActive: max },
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
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
