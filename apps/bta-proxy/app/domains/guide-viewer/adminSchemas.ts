import { z } from "zod";

export const veganLevelSchema = z.enum(["VEGAN", "VEGETARIAN", "VEGAN_OPTIONS", "NONE", "UNKNOWN"]);

export const halalLevelSchema = z.enum([
  "CERTIFIED",
  "MUSLIM_OWNED",
  "NO_PORK",
  "UNKNOWN",
  "NOT_HALAL",
]);

export const meatTypeSchema = z.enum([
  "PORK",
  "BEEF",
  "CHICKEN",
  "LAMB",
  "SEAFOOD",
  "NONE",
  "UNKNOWN",
]);

const categoryBaseSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1),
  depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  parentId: z.string().trim().min(1).nullable().optional(),
  sortOrder: z.number().int().default(0),
  isActive: z.boolean().default(true),
  exposeAsGuide: z.boolean().default(false),
});

function validateCategoryDepthParent(
  data: { depth?: 1 | 2 | 3; parentId?: string | null },
  ctx: z.RefinementCtx,
) {
  if (data.depth === 1 && data.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "depth=1인 경우 parentId를 가질 수 없습니다.",
      path: ["parentId"],
    });
  }

  if (data.depth === 2 && !data.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "depth=2인 경우 depth1 parentId가 필요합니다.",
      path: ["parentId"],
    });
  }

  if (data.depth === 3 && !data.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "depth=3인 경우 depth2 parentId가 필요합니다.",
      path: ["parentId"],
    });
  }
}

export const categoryCreateSchema = categoryBaseSchema.superRefine((data, ctx) => {
  validateCategoryDepthParent(data, ctx);
});

export const categoryUpdateSchema = categoryBaseSchema.partial().superRefine((data, ctx) => {
  validateCategoryDepthParent(data, ctx);
});

export const categoryMoveSchema = z.object({
  direction: z.enum(["up", "down"]),
});

export const restaurantListCreateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  city: z.string().trim().optional(),
  country: z.string().trim().optional(),
  isActive: z.boolean().default(true),
});

export const restaurantListUpdateSchema = restaurantListCreateSchema.partial();

export const dietarySchema = z.object({
  isVeganOnly: z.boolean().default(false),
  hasVeganOptions: z.boolean().default(false),
  veganLevel: veganLevelSchema.default("UNKNOWN"),
  meatTypes: z.array(meatTypeSchema).min(1).default(["UNKNOWN"]),
  halalLevel: halalLevelSchema.default("UNKNOWN"),
  notes: z.string().trim().optional(),
});

export const restaurantItemCreateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  category: z.string().trim().optional(),
  address: z.string().trim().optional(),
  lat: z.number(),
  lng: z.number(),
  tags: z.array(z.string().trim().min(1)).optional(),
  memo: z.string().trim().optional(),
  priority: z.number().int().default(0),
  mapUrl: z.string().trim().url().optional(),
  dietary: dietarySchema,
  photo: z
    .object({
      original: z.object({
        s3Bucket: z.string().trim().min(1),
        s3Key: z.string().trim().min(1),
        mimeType: z.literal("image/jpeg"),
        sizeBytes: z.number().int().nonnegative().nullable().optional(),
        status: z.literal("READY"),
      }),
      thumbnail: z.object({
        s3Bucket: z.string().trim().min(1),
        s3Key: z.string().trim().min(1),
        mimeType: z.literal("image/jpeg"),
        sizeBytes: z.number().int().nonnegative().nullable().optional(),
        status: z.literal("READY"),
      }),
    })
    .nullable()
    .optional(),
});

export const restaurantItemUpdateSchema = restaurantItemCreateSchema.partial();

export const assetUploadUrlSchema = z.object({
  kind: z.enum(["PDF", "VIDEO"]),
  fileName: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
});

export const assetCreateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  kind: z.enum(["PDF", "VIDEO"]),
  title: z.string().trim().min(1),
  s3Bucket: z.string().trim().min(1),
  s3Key: z.string().trim().min(1),
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  checksumSha256: z.string().trim().optional(),
  durationSec: z.number().int().positive().optional(),
  status: z.enum(["UPLOADING", "READY", "FAILED"]).default("READY"),
});

export const assetUpdateSchema = assetCreateSchema.partial();

export const guideCreateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  type: z.enum(["PDF", "VIDEO", "BUNDLE"]),
  thumbnailUrl: z.string().trim().url().optional(),
  isActive: z.boolean().default(true),
});

export const guideUpdateSchema = guideCreateSchema.partial();

export const guideAssetsConfigSchema = z.object({
  pdfAssetId: z.string().trim().min(1).optional(),
  videoAssetId: z.string().trim().min(1).optional(),
});

export const guideRestaurantListSchema = z.object({
  restaurantListId: z.string().trim().min(1),
});

export const entitlementUpsertSchema = z.object({
  customerId: z.string().trim().min(1),
  guideId: z.string().trim().min(1),
  expiresAt: z.string().trim().min(1),
  status: z.enum(["ACTIVE", "REVOKED"]).default("ACTIVE"),
  sourceOrderId: z.string().trim().optional(),
});

export const entitlementDeleteSchema = z.object({
  customerId: z.string().trim().min(1),
  guideId: z.string().trim().min(1),
});

export function validateGuideComposition(
  guideType: "PDF" | "VIDEO" | "BUNDLE",
  config: { pdfAssetId?: string; videoAssetId?: string; restaurantListId?: string },
) {
  if (guideType === "PDF") {
    if (!config.pdfAssetId || config.videoAssetId || config.restaurantListId) {
      return { ok: false, message: "type=PDF는 pdfAssetId만 허용됩니다." };
    }
    return { ok: true as const };
  }
  if (guideType === "VIDEO") {
    if (!config.videoAssetId || config.pdfAssetId || config.restaurantListId) {
      return { ok: false, message: "type=VIDEO는 videoAssetId만 허용됩니다." };
    }
    return { ok: true as const };
  }
  if (!config.pdfAssetId || !config.videoAssetId) {
    return { ok: false, message: "type=BUNDLE은 pdfAssetId와 videoAssetId가 모두 필요합니다." };
  }
  if (!config.restaurantListId) {
    return { ok: false, message: "type=BUNDLE은 restaurantListId가 필요합니다." };
  }
  return { ok: true as const };
}
