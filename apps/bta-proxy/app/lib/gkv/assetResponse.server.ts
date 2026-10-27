type SerializableGkvAsset = {
  sizeBytes: bigint | number | null;
  thumbnailSizeBytes?: bigint | number | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  [key: string]: unknown;
};

function toJsonNumber(value: bigint | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function toJsonDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

export function serializeGkvAssetForJson<T extends SerializableGkvAsset>(asset: T) {
  return {
    ...asset,
    sizeBytes: toJsonNumber(asset.sizeBytes),
    ...(Object.prototype.hasOwnProperty.call(asset, "thumbnailSizeBytes")
      ? { thumbnailSizeBytes: toJsonNumber(asset.thumbnailSizeBytes) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(asset, "createdAt")
      ? { createdAt: toJsonDate(asset.createdAt) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(asset, "updatedAt")
      ? { updatedAt: toJsonDate(asset.updatedAt) }
      : {}),
  };
}
