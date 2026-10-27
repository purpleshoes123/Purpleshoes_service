import type { LoaderFunctionArgs } from "react-router";
import prisma from "~/db.server";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

function mask(value: string | undefined): string | null {
  if (!value || value.length === 0) return null;
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;

  const correlationId = respond.getCorrelationId(request);

  let dbOk = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const bucket = process.env.GKV_S3_BUCKET?.trim();
  const region = process.env.GKV_AWS_REGION?.trim();
  const kakao = process.env.GKV_KAKAO_REST_API_KEY?.trim();

  return respond.ok(
    {
      db: { ok: dbOk },
      s3: {
        ok: Boolean(bucket && region),
        bucket: mask(bucket),
        region: region ?? null,
      },
      kakao: {
        ok: Boolean(kakao),
        key: mask(kakao),
      },
      healthLinks: {
        admin: "/admin/health",
        v1: "/v1/health",
      },
    },
    { correlationId }
  );
};
