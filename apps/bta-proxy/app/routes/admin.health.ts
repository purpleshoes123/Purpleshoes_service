import type { LoaderFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { getGkvEnv } from "~/domains/guide-viewer/env";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";
import prisma from "~/db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }

  const correlationId = respond.getCorrelationId(request);
  const env = getGkvEnv();
  await prisma.$queryRaw`SELECT 1`;

  return respond.ok(
    {
      status: "ok",
      scope: "admin",
      service: "guide-kit-viewer-backend",
      enabled: env.enabled,
      strictMode: env.strictMode,
      db: "ok",
    },
    { correlationId },
  );
};
