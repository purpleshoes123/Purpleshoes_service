import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }

  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId")?.trim();

  if (!customerId) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId 쿼리가 필요합니다."),
      { fieldErrors: { customerId: "customerId를 입력해 주세요." } },
      422,
      correlationId,
    );
  }

  const [devices, sessions] = await Promise.all([
    prisma.gkvDevice.findMany({
      where: { customerId },
      orderBy: [{ lastSeenAt: "desc" }],
    }),
    prisma.gkvSession.findMany({
      where: { customerId },
      orderBy: [{ createdAt: "desc" }],
    }),
  ]);

  const deviceById = new Map(devices.map((device) => [device.deviceId, device]));

  const items = sessions.map((session) => {
    const device = deviceById.get(session.deviceId);
    return {
      sessionId: session.id,
      customerId: session.customerId,
      deviceId: session.deviceId,
      deviceName: device?.deviceName ?? null,
      platform: device?.platform ?? null,
      lastSeenAt: device?.lastSeenAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
      revokedAt: session.revokedAt ? session.revokedAt.toISOString() : null,
      sessionStatus: session.revokedAt ? "revoked" : "active",
    };
  });

  return respond.ok(
    {
      customerId,
      items,
      activeCount: items.filter((item) => item.sessionStatus === "active").length,
      totalCount: items.length,
    },
    { correlationId },
  );
};
