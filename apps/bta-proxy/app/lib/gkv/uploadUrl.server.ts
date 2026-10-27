import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

type UploadMode = "placeholder" | "s3_presign";

type BuildUploadUrlInput = {
  fileName: string;
  mimeType: string;
};

type BuildUploadUrlResult = {
  assetId: string;
  uploadUrl: string;
  s3Bucket: string;
  s3Key: string;
  mode: UploadMode;
};

type UploadObjectInput = {
  s3Bucket: string;
  s3Key: string;
  mimeType: string;
  body: Uint8Array;
};

export type MultipartUploadStartInput = BuildUploadUrlInput & {
  fileSizeBytes: number;
};

export type MultipartUploadStartResult = {
  assetId: string;
  s3Bucket: string;
  s3Key: string;
  uploadId: string;
  uploadToken: string;
  partSizeBytes: number;
  partCount: number;
  mode: "s3_multipart";
};

export type MultipartUploadPartUrl = {
  partNumber: number;
  uploadUrl: string;
};

export type MultipartUploadCompletedPart = {
  partNumber: number;
  eTag: string;
};

type MultipartUploadSession = {
  v: 1;
  exp: number;
  assetId: string;
  s3Bucket: string;
  s3Key: string;
  uploadId: string;
  mimeType: string;
  fileSizeBytes: number;
  partSizeBytes: number;
  partCount: number;
};

const MIB = 1024 * 1024;
const MIN_MULTIPART_PART_SIZE_BYTES = 5 * MIB;
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 64 * MIB;
const MAX_MULTIPART_PARTS = 10_000;
const S3_MAX_OBJECT_SIZE_BYTES = 5 * 1024 * 1024 * 1024 * 1024;

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getUploadMode(): UploadMode {
  const raw = (process.env.GKV_UPLOAD_MODE || "placeholder").trim().toLowerCase();
  return raw === "s3_presign" ? "s3_presign" : "placeholder";
}

function getFileExtension(fileName: string): string {
  return fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";
}

function getUploadExpiresSec(): number {
  const raw = process.env.GKV_S3_UPLOAD_EXPIRES_SEC || "900";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return 900;
  return parsed;
}

function getPositiveIntegerEnv(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {}
): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  if (options.min !== undefined && parsed < options.min) return fallback;
  if (options.max !== undefined && parsed > options.max) return fallback;
  return parsed;
}

function getMultipartPartExpiresSec(): number {
  return getPositiveIntegerEnv("GKV_S3_MULTIPART_PART_EXPIRES_SEC", 86_400, {
    min: 60,
    max: 604_800,
  });
}

function getMultipartSessionTtlSec(): number {
  return getPositiveIntegerEnv("GKV_S3_MULTIPART_SESSION_TTL_SEC", 604_800, {
    min: 300,
    max: 604_800,
  });
}

function getMultipartPartSizeBytes(fileSizeBytes: number): number {
  const configuredMiB = getPositiveIntegerEnv(
    "GKV_S3_MULTIPART_PART_SIZE_MIB",
    DEFAULT_MULTIPART_PART_SIZE_BYTES / MIB,
    {
      min: 5,
      max: 5_120,
    }
  );
  const configuredBytes = configuredMiB * MIB;
  const bytesRequiredForPartCount = Math.ceil(fileSizeBytes / MAX_MULTIPART_PARTS);
  return Math.max(MIN_MULTIPART_PART_SIZE_BYTES, configuredBytes, bytesRequiredForPartCount);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function ensureS3PresignMode(): void {
  if (getUploadMode() !== "s3_presign") {
    throw new Error("GKV_UPLOAD_MODE=s3_presign is required for multipart uploads");
  }
}

function getMultipartTokenSecret(): string {
  return getRequiredEnv("GKV_SIGNED_URL_SECRET");
}

function signMultipartTokenPayload(payload: string): string {
  return createHmac("sha256", getMultipartTokenSecret())
    .update(`gkv-multipart-v1:${payload}`, "utf8")
    .digest("base64url");
}

function encodeMultipartSession(session: MultipartUploadSession): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${signMultipartTokenPayload(payload)}`;
}

function decodeMultipartSession(uploadToken: string): MultipartUploadSession {
  const [payload, signature, ...extra] = uploadToken.split(".");
  if (!payload || !signature || extra.length > 0) {
    throw new Error("Invalid multipart upload token");
  }

  const expected = signMultipartTokenPayload(payload);
  const signatureBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (
    signatureBytes.length !== expectedBytes.length ||
    !timingSafeEqual(signatureBytes, expectedBytes)
  ) {
    throw new Error("Invalid multipart upload token");
  }

  let session: MultipartUploadSession;
  try {
    session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MultipartUploadSession;
  } catch {
    throw new Error("Invalid multipart upload token");
  }

  if (
    session.v !== 1 ||
    !session.assetId ||
    !session.s3Bucket ||
    !session.s3Key ||
    !session.uploadId ||
    !Number.isSafeInteger(session.fileSizeBytes) ||
    session.fileSizeBytes <= 0 ||
    !Number.isSafeInteger(session.partSizeBytes) ||
    session.partSizeBytes < MIN_MULTIPART_PART_SIZE_BYTES ||
    !Number.isInteger(session.partCount) ||
    session.partCount < 1 ||
    session.partCount > MAX_MULTIPART_PARTS ||
    !Number.isInteger(session.exp) ||
    session.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Multipart upload session is invalid or expired");
  }

  return session;
}

function assertPartNumber(session: MultipartUploadSession, partNumber: number): void {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) {
    throw new Error("Invalid multipart upload part number");
  }
}

function createS3Client(): S3Client {
  const region = getRequiredEnv("GKV_AWS_REGION");
  const endpoint = process.env.GKV_S3_ENDPOINT?.trim();
  const forcePathStyle = parseBool(process.env.GKV_S3_FORCE_PATH_STYLE, false);

  return new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(forcePathStyle ? { forcePathStyle: true } : {}),
  });
}

async function buildS3PresignedUpload(input: BuildUploadUrlInput): Promise<BuildUploadUrlResult> {
  const assetId = `asset_${randomUUID()}`;
  const s3Bucket = getRequiredEnv("GKV_S3_BUCKET");
  const s3Key = `gkv-assets/${assetId}/source${getFileExtension(input.fileName)}`;
  const command = new PutObjectCommand({
    Bucket: s3Bucket,
    Key: s3Key,
    ContentType: input.mimeType,
  });
  const uploadUrl = await getSignedUrl(createS3Client(), command, {
    expiresIn: getUploadExpiresSec(),
  });
  return { assetId, uploadUrl, s3Bucket, s3Key, mode: "s3_presign" };
}

function buildPlaceholderUpload(input: BuildUploadUrlInput): BuildUploadUrlResult {
  const assetId = `asset_${randomUUID()}`;
  const s3Bucket = process.env.GKV_S3_BUCKET || "gkv-local-bucket";
  const baseUrl = process.env.GKV_UPLOAD_BASE_URL || "http://localhost:3000";
  const s3Key = `gkv-assets/${assetId}/source${getFileExtension(input.fileName)}`;
  return {
    assetId,
    uploadUrl: `${baseUrl}/admin/gkv/assets/upload-placeholder/${assetId}`,
    s3Bucket,
    s3Key,
    mode: "placeholder",
  };
}

export async function buildAssetUploadUrl(
  input: BuildUploadUrlInput
): Promise<BuildUploadUrlResult> {
  const mode = getUploadMode();
  if (mode === "s3_presign") {
    return buildS3PresignedUpload(input);
  }
  return buildPlaceholderUpload(input);
}

/**
 * Starts a browser-to-S3 multipart upload. This has no application-level file-size cap;
 * S3's service maximum of 5 TiB still applies.
 */
export async function startMultipartAssetUpload(
  input: MultipartUploadStartInput
): Promise<MultipartUploadStartResult> {
  ensureS3PresignMode();
  if (!Number.isSafeInteger(input.fileSizeBytes) || input.fileSizeBytes <= 0) {
    throw new Error("fileSizeBytes must be a positive safe integer");
  }
  if (input.fileSizeBytes > S3_MAX_OBJECT_SIZE_BYTES) {
    throw new Error("S3 multipart uploads support objects up to 5 TiB");
  }

  const assetId = `asset_${randomUUID()}`;
  const s3Bucket = getRequiredEnv("GKV_S3_BUCKET");
  const s3Key = `gkv-assets/${assetId}/source${getFileExtension(input.fileName)}`;
  const partSizeBytes = getMultipartPartSizeBytes(input.fileSizeBytes);
  const partCount = Math.ceil(input.fileSizeBytes / partSizeBytes);
  const client = createS3Client();
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: s3Bucket,
      Key: s3Key,
      ContentType: input.mimeType,
    })
  );
  if (!created.UploadId) {
    throw new Error("S3 did not return a multipart upload ID");
  }

  const session: MultipartUploadSession = {
    v: 1,
    exp: Math.floor(Date.now() / 1000) + getMultipartSessionTtlSec(),
    assetId,
    s3Bucket,
    s3Key,
    uploadId: created.UploadId,
    mimeType: input.mimeType,
    fileSizeBytes: input.fileSizeBytes,
    partSizeBytes,
    partCount,
  };

  return {
    assetId,
    s3Bucket,
    s3Key,
    uploadId: created.UploadId,
    uploadToken: encodeMultipartSession(session),
    partSizeBytes,
    partCount,
    mode: "s3_multipart",
  };
}

export async function signMultipartUploadParts(input: {
  uploadToken: string;
  partNumbers: number[];
}): Promise<MultipartUploadPartUrl[]> {
  ensureS3PresignMode();
  const session = decodeMultipartSession(input.uploadToken);
  const uniquePartNumbers = Array.from(new Set(input.partNumbers));
  if (uniquePartNumbers.length === 0 || uniquePartNumbers.length > 20) {
    throw new Error("Request between 1 and 20 multipart upload parts at a time");
  }

  const client = createS3Client();
  return Promise.all(
    uniquePartNumbers.map(async (partNumber) => {
      assertPartNumber(session, partNumber);
      const uploadUrl = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: session.s3Bucket,
          Key: session.s3Key,
          UploadId: session.uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: getMultipartPartExpiresSec() }
      );
      return { partNumber, uploadUrl };
    })
  );
}

export async function completeMultipartAssetUpload(input: {
  uploadToken: string;
  parts: MultipartUploadCompletedPart[];
}): Promise<{ sizeBytes: number }> {
  ensureS3PresignMode();
  const session = decodeMultipartSession(input.uploadToken);
  if (input.parts.length !== session.partCount) {
    throw new Error("All multipart upload parts must be completed before finalization");
  }

  const byPartNumber = new Map<number, MultipartUploadCompletedPart>();
  for (const part of input.parts) {
    assertPartNumber(session, part.partNumber);
    if (!part.eTag || part.eTag.length > 1024 || byPartNumber.has(part.partNumber)) {
      throw new Error("Invalid multipart upload ETag");
    }
    byPartNumber.set(part.partNumber, part);
  }

  const parts = Array.from({ length: session.partCount }, (_, index) => {
    const part = byPartNumber.get(index + 1);
    if (!part) {
      throw new Error("All multipart upload parts must be completed before finalization");
    }
    return { PartNumber: part.partNumber, ETag: part.eTag };
  });

  const client = createS3Client();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: session.s3Bucket,
      Key: session.s3Key,
      UploadId: session.uploadId,
      MultipartUpload: { Parts: parts },
    })
  );

  const head = await client.send(
    new HeadObjectCommand({ Bucket: session.s3Bucket, Key: session.s3Key })
  );
  if (typeof head.ContentLength !== "number" || head.ContentLength !== session.fileSizeBytes) {
    throw new Error("Completed multipart object size does not match the selected file");
  }
  return { sizeBytes: head.ContentLength };
}

export async function abortMultipartAssetUpload(input: { uploadToken: string }): Promise<void> {
  ensureS3PresignMode();
  const session = decodeMultipartSession(input.uploadToken);
  const client = createS3Client();
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: session.s3Bucket,
      Key: session.s3Key,
      UploadId: session.uploadId,
    })
  );
}

export async function uploadObjectToS3(input: UploadObjectInput): Promise<void> {
  const client = createS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: input.s3Bucket,
      Key: input.s3Key,
      ContentType: input.mimeType,
      Body: input.body,
    })
  );
}
