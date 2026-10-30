import prisma from "~/db.server.ts";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { respond } from "~/lib/respond";

export type GkvActiveSessionItem = {
  id: string;
  deviceId: string;
  deviceName: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

export type GkvSessionIdentifiers = {
  sessionId: string | null;
  deviceId: string | null;
};

function getHeaderValue(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim();
  return value || null;
}

export function getGkvSessionIdentifiers(request: Request): GkvSessionIdentifiers {
  return {
    sessionId: getHeaderValue(request, "X-GKV-Session-Id"),
    deviceId: getHeaderValue(request, "X-GKV-Device-Id"),
  };
}

export async function listActiveGkvSessions(customerId: string): Promise<GkvActiveSessionItem[]> {
  const [sessions, devices] = await Promise.all([
    prisma.gkvSession.findMany({
      where: { customerId, revokedAt: null },
      orderBy: [{ createdAt: "desc" }],
    }),
    prisma.gkvDevice.findMany({
      where: { customerId },
    }),
  ]);
  const deviceById = new Map(devices.map((device) => [device.deviceId, device]));

  return sessions.map((session) => {
    const device = deviceById.get(session.deviceId);
    return {
      id: session.id,
      deviceId: session.deviceId,
      deviceName: device?.deviceName ?? null,
      platform: device?.platform ?? null,
      lastSeenAt: device?.lastSeenAt ? device.lastSeenAt.toISOString() : null,
      createdAt: session.createdAt.toISOString(),
    };
  });
}

export async function requireActiveGkvSession(
  request: Request,
  customerId: string,
  correlationId = respond.getCorrelationId(request),
): Promise<GkvActiveSessionItem | Response> {
  const { sessionId, deviceId } = getGkvSessionIdentifiers(request);
  if (!sessionId || !deviceId) {
    return respond.withNoStore(
      respond.fail(
        ErrorCode.GKV_SESSION_REQUIRED,
        getErrorMessage(ErrorCode.GKV_SESSION_REQUIRED),
        undefined,
        getErrorStatus(ErrorCode.GKV_SESSION_REQUIRED),
        correlationId,
      ),
    );
  }

  const activeSessions = await listActiveGkvSessions(customerId);

  const session = activeSessions.find((item) => {
    if (sessionId && item.id !== sessionId) {
      return false;
    }
    if (deviceId && item.deviceId !== deviceId) {
      return false;
    }
    return true;
  });

  if (!session) {
    return respond.withNoStore(
      respond.fail(
        ErrorCode.GKV_SESSION_INACTIVE,
        getErrorMessage(ErrorCode.GKV_SESSION_INACTIVE),
        undefined,
        getErrorStatus(ErrorCode.GKV_SESSION_INACTIVE),
        correlationId,
      ),
    );
  }

  await prisma.gkvDevice.updateMany({
    where: { customerId, deviceId: session.deviceId },
    data: { lastSeenAt: new Date() },
  });

  return session;
}
