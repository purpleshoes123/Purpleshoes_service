import type { LoaderFunctionArgs } from "react-router";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import prisma from "~/db.server";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import { verifyGkvSignedUrl } from "~/lib/gkv/signedUrl";
import { respond } from "~/lib/respond";

function getS3Client(): S3Client {
  const region = process.env.GKV_AWS_REGION?.trim();
  if (!region) {
    throw new Error("GKV_AWS_REGION is required");
  }
  const endpoint = process.env.GKV_S3_ENDPOINT?.trim();
  const forcePathStyle = (process.env.GKV_S3_FORCE_PATH_STYLE || "").trim().toLowerCase();
  return new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(forcePathStyle === "1" || forcePathStyle === "true" ? { forcePathStyle: true } : {}),
  });
}

function extractS3Key(requestUrl: URL): string | null {
  const prefix = "/gkv/";
  const idx = requestUrl.pathname.indexOf(prefix);
  if (idx < 0) return null;
  const encoded = requestUrl.pathname.slice(idx + prefix.length);
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

async function resolveSignedResource(assetId: string, s3Key: string) {
  const asset = await prisma.gkvAsset.findUnique({ where: { id: assetId } });
  if (asset?.status === "READY" && asset.s3Key === s3Key) {
    return {
      s3Bucket: asset.s3Bucket,
      s3Key: asset.s3Key,
      mimeType: asset.mimeType,
    };
  }

  const restaurant = await prisma.gkvRestaurant.findUnique({ where: { id: assetId } });
  if (restaurant?.photoOriginalKey === s3Key && restaurant.photoOriginalBucket) {
    return {
      s3Bucket: restaurant.photoOriginalBucket,
      s3Key,
      mimeType: restaurant.photoOriginalMimeType ?? "image/jpeg",
    };
  }
  if (restaurant?.photoThumbnailKey === s3Key && restaurant.photoThumbnailBucket) {
    return {
      s3Bucket: restaurant.photoThumbnailBucket,
      s3Key,
      mimeType: restaurant.photoThumbnailMimeType ?? "image/jpeg",
    };
  }

  const restaurantItem = await prisma.gkvRestaurantItem.findUnique({ where: { id: assetId } });
  if (restaurantItem?.photoOriginalKey === s3Key && restaurantItem.photoOriginalBucket) {
    return {
      s3Bucket: restaurantItem.photoOriginalBucket,
      s3Key,
      mimeType: restaurantItem.photoOriginalMimeType ?? "image/jpeg",
    };
  }
  if (restaurantItem?.photoThumbnailKey === s3Key && restaurantItem.photoThumbnailBucket) {
    return {
      s3Bucket: restaurantItem.photoThumbnailBucket,
      s3Key,
      mimeType: restaurantItem.photoThumbnailMimeType ?? "image/jpeg",
    };
  }

  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const s3Key = extractS3Key(url);
  const exp = Number(url.searchParams.get("exp") || "");
  const sig = url.searchParams.get("sig") || "";
  const assetId = url.searchParams.get("aid") || "";
  const customerId = url.searchParams.get("cid") || "";

  if (!s3Key || !Number.isInteger(exp) || !sig || !assetId || !customerId) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (exp <= nowSec) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  const verified = verifyGkvSignedUrl({
    assetId,
    customerId,
    s3Key,
    exp,
    sig,
  });
  if (!verified) {
    return respond.fail(
      ErrorCode.AUTH_LOGIN_REQUIRED,
      getErrorMessage(ErrorCode.AUTH_LOGIN_REQUIRED),
      undefined,
      getErrorStatus(ErrorCode.AUTH_LOGIN_REQUIRED),
      correlationId
    );
  }

  const resource = await resolveSignedResource(assetId, s3Key);
  if (!resource) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "파일을 찾을 수 없거나 READY 상태가 아닙니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId
    );
  }

  const range = request.headers.get("Range") || undefined;
  try {
    const command = new GetObjectCommand({
      Bucket: resource.s3Bucket,
      Key: resource.s3Key,
      ...(range ? { Range: range } : {}),
    });
    const object = await getS3Client().send(command);
    const body = object.Body as
      | { transformToWebStream?: () => ReadableStream<Uint8Array> }
      | ReadableStream<Uint8Array>
      | null
      | undefined;
    const stream =
      body && typeof (body as { transformToWebStream?: () => ReadableStream<Uint8Array> }).transformToWebStream === "function"
        ? (body as { transformToWebStream: () => ReadableStream<Uint8Array> }).transformToWebStream()
        : (body as ReadableStream<Uint8Array> | null | undefined);

    if (!stream) {
      return respond.fail(
        ErrorCode.INTERNAL_ERROR,
        getErrorMessage(ErrorCode.INTERNAL_ERROR),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_ERROR),
        correlationId
      );
    }

    const headers = new Headers();
    headers.set("Cache-Control", "private, max-age=60");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Type", object.ContentType || resource.mimeType);
    if (object.ContentLength !== undefined) headers.set("Content-Length", String(object.ContentLength));
    if (object.ETag) headers.set("ETag", object.ETag);
    if (object.ContentRange) headers.set("Content-Range", object.ContentRange);

    return new Response(stream, {
      status: object.ContentRange ? 206 : 200,
      headers,
    });
  } catch {
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId
    );
  }
};
