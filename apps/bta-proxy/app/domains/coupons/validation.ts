import { z } from "zod";

const cartLineSchema = z.object({
  productId: z.union([z.string(), z.number()]).optional().nullable(),
  variantId: z.union([z.string(), z.number()]).optional().nullable(),
  sku: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  productType: z.string().optional().nullable(),
  collections: z.array(z.string()).optional().nullable(),
});

export const couponsSyncSchema = z.object({
  customerId: z.string().optional().nullable(),
  cartId: z.string().min(1, "cartId는 필수입니다."),
  mediaConsent: z.boolean(),
  wantsExtra10: z.boolean(),
  entitled15: z.boolean().optional().nullable(),
  cartLines: z.array(cartLineSchema).default([]),
});

export const shareIntentSchema = z.object({
  customerId: z.string().min(1, "customerId는 필수입니다."),
});

export const shareCompletedSchema = z.object({
  shareEventId: z.string().min(1, "shareEventId는 필수입니다."),
  customerId: z.string().optional().nullable(),
});

export const extra10ActivateShareSchema = z.object({
  shareUrl: z.string().url("shareUrl은 올바른 URL이어야 합니다."),
  source: z.string().min(1, "source는 필수입니다."),
  clientRequestId: z.string().min(1, "clientRequestId는 빈 문자열일 수 없습니다.").optional(),
});

export const tourCompletedSchema = z.object({
  customerId: z.string().min(1, "customerId는 필수입니다."),
  completionId: z.string().min(1, "completionId는 필수입니다."),
  completedAt: z.number().int().optional(),
});

export const reviewCompletedSchema = z.object({
  customerId: z.string().min(1, "customerId는 필수입니다."),
  reviewId: z.string().min(1, "reviewId는 필수입니다."),
  completedAt: z.number().int().optional(),
});

export const adminIssueSchema = z.object({
  customerId: z.string().min(1, "customerId는 필수입니다."),
  couponKind: z.enum(["GUIDE50", "EXTRA10", "TOUR15", "TOUR5", "TOUR20"]),
});

export const adminRevokeSchema = z.object({
  customerId: z.string().min(1, "customerId는 필수입니다."),
  couponKind: z.enum(["GUIDE50", "EXTRA10", "TOUR15", "TOUR5", "TOUR20"]).optional(),
  code: z.string().optional(),
  reason: z.string().optional(),
});

export const adminReissueSchema = z.object({
  customerId: z.string().min(1, "customerId는 필수입니다."),
  couponKind: z.enum(["GUIDE50", "EXTRA10", "TOUR15", "TOUR5", "TOUR20"]),
  reason: z.string().optional(),
});

export const reconcileSchema = z.object({
  customerId: z.string().min(1, "customerId는 필수입니다."),
  dryRun: z.boolean().optional(),
});
