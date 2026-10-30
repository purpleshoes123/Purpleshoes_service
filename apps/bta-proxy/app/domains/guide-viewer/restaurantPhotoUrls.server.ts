import { buildGkvSignedUrl } from "~/domains/guide-viewer/signedUrl";

export type RestaurantPhotoStorage = {
  photoOriginalBucket: string | null;
  photoOriginalKey: string | null;
  photoOriginalMimeType: string | null;
  photoOriginalSizeBytes: bigint | number | null;
  photoThumbnailBucket: string | null;
  photoThumbnailKey: string | null;
  photoThumbnailMimeType: string | null;
  photoThumbnailSizeBytes: bigint | number | null;
};

export type RestaurantPhotoMeta = {
  original: {
    s3Bucket: string;
    s3Key: string;
    mimeType: "image/jpeg";
    sizeBytes: number | null;
    status: "READY";
  };
  thumbnail: {
    s3Bucket: string;
    s3Key: string;
    mimeType: "image/jpeg";
    sizeBytes: number | null;
    status: "READY";
  };
};

function toNumber(value: bigint | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Number(value);
}

export function serializeRestaurantPhotoMeta(
  row: RestaurantPhotoStorage,
): RestaurantPhotoMeta | null {
  if (
    !row.photoOriginalBucket ||
    !row.photoOriginalKey ||
    !row.photoThumbnailBucket ||
    !row.photoThumbnailKey
  ) {
    return null;
  }

  return {
    original: {
      s3Bucket: row.photoOriginalBucket,
      s3Key: row.photoOriginalKey,
      mimeType: "image/jpeg",
      sizeBytes: toNumber(row.photoOriginalSizeBytes),
      status: "READY",
    },
    thumbnail: {
      s3Bucket: row.photoThumbnailBucket,
      s3Key: row.photoThumbnailKey,
      mimeType: "image/jpeg",
      sizeBytes: toNumber(row.photoThumbnailSizeBytes),
      status: "READY",
    },
  };
}

export function buildRestaurantPhotoUrls(
  resourceId: string,
  row: RestaurantPhotoStorage,
  customerId: string,
): { photoUrl: string | null; photoThumbnailUrl: string | null } {
  const photoUrl = row.photoOriginalKey
    ? buildGkvSignedUrl({
        assetId: resourceId,
        customerId,
        s3Key: row.photoOriginalKey,
      }).url
    : null;
  const photoThumbnailUrl = row.photoThumbnailKey
    ? buildGkvSignedUrl({
        assetId: resourceId,
        customerId,
        s3Key: row.photoThumbnailKey,
      }).url
    : null;

  return { photoUrl, photoThumbnailUrl };
}

export function toRestaurantPhotoData(photo: RestaurantPhotoMeta | null) {
  if (!photo) {
    return {
      photoOriginalBucket: null,
      photoOriginalKey: null,
      photoOriginalMimeType: null,
      photoOriginalSizeBytes: null,
      photoThumbnailBucket: null,
      photoThumbnailKey: null,
      photoThumbnailMimeType: null,
      photoThumbnailSizeBytes: null,
    };
  }

  return {
    photoOriginalBucket: photo.original.s3Bucket,
    photoOriginalKey: photo.original.s3Key,
    photoOriginalMimeType: photo.original.mimeType,
    photoOriginalSizeBytes:
      photo.original.sizeBytes === null || photo.original.sizeBytes === undefined
        ? null
        : BigInt(photo.original.sizeBytes),
    photoThumbnailBucket: photo.thumbnail.s3Bucket,
    photoThumbnailKey: photo.thumbnail.s3Key,
    photoThumbnailMimeType: photo.thumbnail.mimeType,
    photoThumbnailSizeBytes:
      photo.thumbnail.sizeBytes === null || photo.thumbnail.sizeBytes === undefined
        ? null
        : BigInt(photo.thumbnail.sizeBytes),
  };
}
