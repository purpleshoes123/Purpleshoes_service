import { randomUUID } from "crypto";
import sharp from "sharp";
import type { RestaurantPhotoMeta } from "~/lib/gkv/restaurantPhotoUrls.server";
import { uploadObjectToS3 } from "~/lib/gkv/uploadUrl.server";

const OUTPUT_MIME_TYPE = "image/jpeg" as const;
const ORIGINAL_SIZE = 1080;
const THUMBNAIL_SIZE = 512;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const SUPPORTED_INPUT_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export class RestaurantPhotoUploadError extends Error {
  readonly status: number;
  readonly code: string;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: { status: number; code: string; cause?: unknown }
  ) {
    super(message);
    this.name = "RestaurantPhotoUploadError";
    this.status = options.status;
    this.code = options.code;
    this.cause = options.cause;
  }
}

type RestaurantPhotoResourceType = "restaurant" | "restaurant-item";

type ProcessAndUploadRestaurantPhotoInput = {
  resourceId: string;
  resourceType: RestaurantPhotoResourceType;
  file: Blob;
};

function getBucket(): string {
  const bucket = process.env.GKV_S3_BUCKET?.trim();
  if (shouldUploadToS3() && !bucket) {
    throw new RestaurantPhotoUploadError("사진 저장소 설정이 누락되었습니다. GKV_S3_BUCKET을 확인해 주세요.", {
      status: 503,
      code: "RESTAURANT_PHOTO_BUCKET_MISSING",
    });
  }
  return bucket || "gkv-local-bucket";
}

function shouldUploadToS3(): boolean {
  return (process.env.GKV_UPLOAD_MODE || "placeholder").trim().toLowerCase() === "s3_presign";
}

function getResourcePrefix(type: RestaurantPhotoResourceType): string {
  return type === "restaurant" ? "gkv-assets/gkv-restaurants" : "gkv-assets/gkv-restaurant-items";
}

function assertSupportedInputType(file: Blob): void {
  const mimeType = file.type.trim().toLowerCase();
  if (!mimeType) {
    return;
  }

  if (!SUPPORTED_INPUT_MIME_TYPES.has(mimeType)) {
    throw new RestaurantPhotoUploadError("JPG, PNG, WebP 사진만 업로드할 수 있습니다.", {
      status: 415,
      code: "RESTAURANT_PHOTO_UNSUPPORTED_TYPE",
    });
  }
}

async function resizeSquare(input: Buffer, size: number, quality: number): Promise<Buffer> {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" })
    .rotate()
    .resize(size, size, {
      fit: "cover",
      position: "attention",
    })
    .jpeg({
      quality,
      mozjpeg: true,
    })
    .toBuffer();
}

export async function processAndUploadRestaurantPhoto(
  input: ProcessAndUploadRestaurantPhotoInput
): Promise<RestaurantPhotoMeta> {
  if (input.file.size > MAX_INPUT_BYTES) {
    throw new RestaurantPhotoUploadError("사진은 20MB 이하로 업로드해 주세요.", {
      status: 413, code: "RESTAURANT_PHOTO_TOO_LARGE",
    });
  }
  assertSupportedInputType(input.file);

  let sourceBuffer: Buffer;
  try {
    sourceBuffer = Buffer.from(await input.file.arrayBuffer());
  } catch (error) {
    throw new RestaurantPhotoUploadError("업로드한 사진 파일을 읽지 못했습니다. 다시 선택해 주세요.", {
      status: 400,
      code: "RESTAURANT_PHOTO_READ_FAILED",
      cause: error,
    });
  }
  if (sourceBuffer.length === 0) {
    throw new RestaurantPhotoUploadError("업로드할 사진 파일이 비어 있습니다.", {
      status: 400,
      code: "RESTAURANT_PHOTO_EMPTY_FILE",
    });
  }

  // Check file signatures before handing bytes to native image decoders.
  const jpeg = sourceBuffer[0] === 0xff && sourceBuffer[1] === 0xd8 && sourceBuffer[2] === 0xff;
  const png = sourceBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = sourceBuffer.toString("ascii", 0, 4) === "RIFF" && sourceBuffer.toString("ascii", 8, 12) === "WEBP";
  if (!jpeg && !png && !webp) {
    throw new RestaurantPhotoUploadError("JPG, PNG, WebP 사진만 업로드할 수 있습니다.", {
      status: 415, code: "RESTAURANT_PHOTO_UNSUPPORTED_TYPE",
    });
  }

  let original: Buffer;
  let thumbnail: Buffer;
  try {
    original = await resizeSquare(sourceBuffer, ORIGINAL_SIZE, 88);
    thumbnail = await resizeSquare(original, THUMBNAIL_SIZE, 84);
  } catch (error) {
    throw new RestaurantPhotoUploadError(
      "사진 파일을 읽거나 변환하지 못했습니다. JPG, PNG, WebP 파일로 다시 업로드해 주세요.",
      {
        status: 422,
        code: "RESTAURANT_PHOTO_PROCESS_FAILED",
        cause: error,
      }
    );
  }

  const bucket = getBucket();
  const version = randomUUID();
  const prefix = getResourcePrefix(input.resourceType);
  const baseKey = `${prefix}/${input.resourceId}/photos/${version}`;
  const originalKey = `${baseKey}/original-1080.jpg`;
  const thumbnailKey = `${baseKey}/thumbnail-512.jpg`;

  if (shouldUploadToS3()) {
    try {
      await Promise.all([
        uploadObjectToS3({
          s3Bucket: bucket,
          s3Key: originalKey,
          mimeType: OUTPUT_MIME_TYPE,
          body: original,
        }),
        uploadObjectToS3({
          s3Bucket: bucket,
          s3Key: thumbnailKey,
          mimeType: OUTPUT_MIME_TYPE,
          body: thumbnail,
        }),
      ]);
    } catch (error) {
      throw new RestaurantPhotoUploadError(
        "사진 파일을 저장소에 업로드하지 못했습니다. S3 설정과 권한을 확인해 주세요.",
        {
          status: 503,
          code: "RESTAURANT_PHOTO_STORAGE_FAILED",
          cause: error,
        }
      );
    }
  }

  return {
    original: {
      s3Bucket: bucket,
      s3Key: originalKey,
      mimeType: OUTPUT_MIME_TYPE,
      sizeBytes: original.byteLength,
      status: "READY",
    },
    thumbnail: {
      s3Bucket: bucket,
      s3Key: thumbnailKey,
      mimeType: OUTPUT_MIME_TYPE,
      sizeBytes: thumbnail.byteLength,
      status: "READY",
    },
  };
}
