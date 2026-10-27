import { z } from "zod";
import { isNaverPlaceUrl } from "./naverPlaceUrl";

export const gkvDomainKindSchema = z.enum(["PDF", "VIDEO"]);
export type GkvDomainKind = z.infer<typeof gkvDomainKindSchema>;

export const gkvMeatTypeSchema = z.enum(["BEEF", "PORK", "CHICKEN", "FISH", "OTHER"]);
export type GkvMeatType = z.infer<typeof gkvMeatTypeSchema>;

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const requiredString = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "필수입니다")
    .max(max, `${max}자 이하로 입력해 주세요.`);

const scopedCategoryBaseSchema = z.object({
  id: optionalString,
  name: requiredString(60),
  slug: requiredString(80).regex(slugRegex, "slug 형식이 올바르지 않습니다."),
  depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  parentId: optionalString.nullable().transform((value) => value ?? undefined),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

function validateCategoryDepthParent(
  data: { depth?: 1 | 2 | 3; parentId?: string },
  ctx: z.RefinementCtx
) {
  if (data.depth === 1 && data.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parentId"],
      message: "depth=1은 상위 카테고리를 가질 수 없습니다.",
    });
  }

  if (data.depth === 2 && !data.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parentId"],
      message: "depth=2는 상위 depth1 카테고리가 필요합니다.",
    });
  }

  if (data.depth === 3 && !data.parentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parentId"],
      message: "depth=3은 상위 depth2 카테고리가 필요합니다.",
    });
  }
}

export const scopedCategoryCreateSchema = scopedCategoryBaseSchema.superRefine((data, ctx) => {
  validateCategoryDepthParent(data, ctx);
});

export const scopedCategoryUpdateSchema = scopedCategoryBaseSchema
  .partial()
  .superRefine((data, ctx) => {
    validateCategoryDepthParent(data, ctx);
  });

const fileSchema = z.object({
  assetId: requiredString(120),
  s3Bucket: requiredString(120),
  s3Key: requiredString(500),
  mimeType: requiredString(120),
  sizeBytes: z.number().int().nonnegative().optional(),
  status: z.literal("READY"),
});

const thumbnailSchema = z.object({
  assetId: optionalString,
  s3Bucket: requiredString(120),
  s3Key: requiredString(500),
  mimeType: z.enum(["image/jpeg", "image/png"]),
  sizeBytes: z.number().int().nonnegative().optional(),
  status: z.literal("READY"),
});

function buildAssetUpsertSchema(kind: GkvDomainKind) {
  const fileMime = kind === "PDF" ? "application/pdf" : "video/mp4";
  return z
    .object({
      id: optionalString,
      title: requiredString(120),
      categoryIds: z.array(z.string().trim().min(1)).min(1, "카테고리를 선택해 주세요."),
      file: fileSchema,
      thumbnail: thumbnailSchema.optional(),
      isActive: z.boolean().default(true),
      description: z
        .string()
        .trim()
        .max(2000, "설명은 2000자 이하로 입력해 주세요.")
        .optional()
        .or(z.literal(""))
        .transform((value) => (value ? value : undefined)),
    })
    .superRefine((data, ctx) => {
      if (data.file.mimeType !== fileMime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["file", "mimeType"],
          message: `${kind} 파일 MIME 타입이 아닙니다.`,
        });
      }
      if (data.categoryIds.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["categoryIds"],
          message: "v1에서는 카테고리 1개만 선택할 수 있습니다.",
        });
      }
    });
}

export const pdfAssetUpsertSchema = buildAssetUpsertSchema("PDF");
export const videoAssetUpsertSchema = buildAssetUpsertSchema("VIDEO");

export const uploadUrlRequestSchema = z
  .object({
    kind: z.enum(["PDF", "VIDEO", "THUMBNAIL"]),
    fileName: requiredString(255),
    mimeType: requiredString(120),
  })
  .superRefine((data, ctx) => {
    const ok =
      (data.kind === "PDF" && data.mimeType === "application/pdf") ||
      (data.kind === "VIDEO" && data.mimeType === "video/mp4") ||
      (data.kind === "THUMBNAIL" && ["image/jpeg", "image/png"].includes(data.mimeType));
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mimeType"],
        message: "kind와 mimeType 조합이 올바르지 않습니다.",
      });
    }
  });

export const videoMultipartStartRequestSchema = z.object({
  kind: z.literal("VIDEO"),
  fileName: requiredString(255),
  mimeType: z.literal("video/mp4"),
  fileSizeBytes: z
    .number()
    .int()
    .positive()
    .refine(Number.isSafeInteger, "파일 크기가 올바르지 않습니다."),
});

export const multipartUploadTokenSchema = requiredString(10_000);

export const multipartUploadPartsRequestSchema = z.object({
  uploadToken: multipartUploadTokenSchema,
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(20),
});

export const multipartUploadCompleteRequestSchema = z.object({
  uploadToken: multipartUploadTokenSchema,
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().min(1).max(10_000),
        eTag: requiredString(1_024),
      })
    )
    .min(1)
    .max(10_000),
});

export const restaurantCategoryUpsertSchema = z.object({
  id: optionalString,
  name: requiredString(60),
  slug: optionalString
    .or(z.literal(""))
    .transform((value) => value || undefined)
    .pipe(z.string().regex(slugRegex, "slug 형식이 올바르지 않습니다.").optional()),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

export const areaUpsertSchema = z.object({
  id: optionalString,
  name: requiredString(60),
  slug: optionalString
    .or(z.literal(""))
    .transform((value) => value || undefined)
    .pipe(z.string().regex(slugRegex, "slug 형식이 올바르지 않습니다.").optional()),
  sortOrder: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

const restaurantPhotoFileSchema = z.object({
  s3Bucket: requiredString(120),
  s3Key: requiredString(500),
  mimeType: z.literal("image/jpeg"),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  status: z.literal("READY"),
});

export const restaurantPhotoSchema = z.object({
  original: restaurantPhotoFileSchema,
  thumbnail: restaurantPhotoFileSchema,
});

export const restaurantUpsertSchema = z.object({
  naverPlaceUrl: z.string().trim().max(2000)
    .refine((value) => !value || isNaverPlaceUrl(value), "네이버 장소 상세 또는 공유 링크를 입력해 주세요.")
    .nullable().optional(),
  id: optionalString,
  name: requiredString(120),
  areaId: requiredString(120),
  categoryIds: z.array(z.string().trim().min(1)).min(1, "카테고리를 1개 이상 선택해 주세요."),
  veganRecommended: z.boolean().default(false),
  meatTypes: z.array(gkvMeatTypeSchema).default([]),
  address: requiredString(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  kakaoPlaceId: optionalString
    .or(z.literal(""))
    .transform((value) => value || undefined)
    .pipe(z.string().max(40).optional()),
  tags: z.array(z.string().trim().min(1)).optional(),
  memo: optionalString
    .or(z.literal(""))
    .transform((value) => value || undefined)
    .pipe(z.string().max(2000).optional()),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
  photo: restaurantPhotoSchema.nullable().optional(),
});

export const restaurantFilterSchema = z.object({
  q: optionalString,
  categoryIds: z.array(z.string().trim().min(1)).optional(),
  areaId: optionalString,
  veganRecommended: z.boolean().optional(),
  meatTypes: z.array(gkvMeatTypeSchema).optional(),
  isActive: z.boolean().optional(),
  sort: z.enum(["priority", "newest", "name"]).default("priority"),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: optionalString,
});

export const sessionRevokeSchema = z
  .object({
    customerId: requiredString(120),
    sessionId: optionalString,
    deviceId: optionalString,
  })
  .superRefine((data, ctx) => {
    if (!data.sessionId && !data.deviceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sessionId"],
        message: "sessionId 또는 deviceId가 필요합니다.",
      });
    }
  });

export const sessionRevokeAllSchema = z.object({
  customerId: requiredString(120),
});

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
    return [];
  } catch {
    return [];
  }
}

export function zodToFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form";
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}
