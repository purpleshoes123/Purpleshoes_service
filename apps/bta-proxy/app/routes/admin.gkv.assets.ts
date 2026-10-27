import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { randomUUID } from "crypto";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { listGkvAssetsWithUsage } from "~/lib/gkv/adminAssetUsage.server";
import { assetCreateSchema } from "~/lib/gkv/adminSchemas";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);

  return respond.ok(await listGkvAssetsWithUsage(), { correlationId });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) return authFail;
  const correlationId = respond.getCorrelationId(request);

  try {
    const payload = assetCreateSchema.parse(await request.json());
    const id = payload.id ?? `asset_${randomUUID()}`;
    const created = await prisma.gkvAsset.create({
      data: {
        id,
        kind: payload.kind,
        title: payload.title,
        s3Bucket: payload.s3Bucket,
        s3Key: payload.s3Key,
        mimeType: payload.mimeType,
        sizeBytes: payload.sizeBytes,
        checksumSha256: payload.checksumSha256,
        durationSec: payload.durationSec,
        status: payload.status,
      },
    });
    return respond.ok({ id: created.id }, { correlationId });
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
