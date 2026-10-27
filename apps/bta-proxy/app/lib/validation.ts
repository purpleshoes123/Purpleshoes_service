import { z } from "zod";

/**
 * SSOT 5장: 입력 스키마
 * 모든 입력은 이 스키마로 검증됩니다.
 */

/**
 * 날짜 형식 검증 (YYYY-MM-DD)
 */
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "날짜는 YYYY-MM-DD 형식이어야 합니다.",
});

/**
 * 시간 형식 검증 (HH:mm)
 */
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, {
  message: "시간은 HH:mm 형식이어야 합니다.",
});

/**
 * SSOT 5.1: Availability (Query 파라미터)
 * SSOT 6.1: 추가 도메인 제약/운영 설정
 */
export const availabilitySchema = z.object({
  productId: z.string().min(1, "productId는 필수입니다."),
  date: dateSchema,
  pax: z
    .number()
    .int("인원수는 정수여야 합니다.")
    .min(1, "인원수는 최소 1명이어야 합니다.")
    .max(20, "인원수는 최대 20명까지 가능합니다."),
  option: z.string().optional(),
  time: timeSchema.optional(),
  // 도메인 제약/운영 설정
  bookingMode: z.enum(["private", "shared"]).optional().default("private"),
  poolKey: z.string().optional().default("DEFAULT"),
  guideUnitsRequired: z
    .number()
    .int("guideUnitsRequired는 정수여야 합니다.")
    .min(1, "guideUnitsRequired는 최소 1이어야 합니다.")
    .max(10, "guideUnitsRequired는 최대 10까지 가능합니다.")
    .optional()
    .default(1),
});

export type AvailabilityInput = z.infer<typeof availabilitySchema>;

/**
 * Travelers 스키마 (Phase 5-6)
 */
const travelersSchema = z.object({
  adult: z.number().int("성인 수는 정수여야 합니다.").min(1, "성인 수는 최소 1명이어야 합니다."),
  child: z.number().int("아동 수는 정수여야 합니다.").min(0, "아동 수는 0 이상이어야 합니다.").default(0),
  infant: z.number().int("유아 수는 정수여야 합니다.").min(0, "유아 수는 0 이상이어야 합니다.").default(0),
});

/**
 * SSOT 5.2: Quote (JSON body)
 * pax는 문자열 또는 숫자로 받을 수 있으며, 숫자로 변환합니다.
 * Phase 5-3: bookingMode/poolKey/guideUnitsRequired 추가
 * Phase 5-6: travelers 필드 추가 (optional, pax와 호환)
 */
// 기본 객체 스키마 (extend를 위해 분리)
const quoteBaseSchema = z.object({
  productId: z.string().min(1, "productId는 필수입니다."),
  date: dateSchema.optional(),
  pax: z
    .union([z.string(), z.number()])
    .transform((val) => (typeof val === "string" ? Number(val) : val))
    .pipe(z.number().int("인원수는 정수여야 합니다.").min(1, "인원수는 최소 1명이어야 합니다."))
    .optional(),
  options: z.record(z.unknown()).optional(),
  currency: z.string().optional().default("KRW"),
  // Phase 5-3: 도메인 제약/운영 설정
  bookingMode: z.enum(["private", "shared"]).optional().default("private"),
  poolKey: z.string().optional().default("DEFAULT"),
  guideUnitsRequired: z
    .union([z.string(), z.number()])
    .transform((val) => (typeof val === "string" ? Number(val) : val))
    .pipe(
      z
        .number()
        .int("guideUnitsRequired는 정수여야 합니다.")
        .min(1, "guideUnitsRequired는 최소 1이어야 합니다.")
        .max(10, "guideUnitsRequired는 최대 10까지 가능합니다.")
    )
    .optional()
    .default(1),
  // Phase 5-6: travelers 필드 (optional)
  travelers: travelersSchema.optional(),
});

// refine을 포함한 최종 quoteSchema
export const quoteSchema = quoteBaseSchema.refine(
  (data) => {
    // travelers가 있으면 total 계산 및 검증
    if (data.travelers) {
      const total = data.travelers.adult + data.travelers.child + data.travelers.infant;
      if (total < 1 || total > 20) {
        return false;
      }
      // pax가 있으면 일치 여부 검증
      if (data.pax !== undefined && data.pax !== total) {
        return false;
      }
    } else {
      // travelers가 없으면 pax는 필수
      if (data.pax === undefined) {
        return false;
      }
      if (data.pax < 1 || data.pax > 20) {
        return false;
      }
    }
    return true;
  },
  {
    message: "travelers가 있으면 총 인원수(adult+child+infant)는 1~20명이어야 하며, pax와 일치해야 합니다. travelers가 없으면 pax는 필수이며 1~20명이어야 합니다.",
  }
);

export type QuoteInput = z.infer<typeof quoteSchema>;

/**
 * 고객 정보 스키마
 */
const customerSchema = z.object({
  name: z.string().min(1, "고객 이름은 필수입니다."),
  phone: z.string().optional(),
  email: z.string().email("올바른 이메일 형식이 아닙니다.").optional(),
});

/**
 * SSOT 5.3: Reservations (JSON body)
 * Quote 바디 + 고객 정보 + idempotency 키
 */
export const reservationsSchema = quoteBaseSchema.extend({
  customer: customerSchema,
  clientRequestId: z.string().optional(),
}).refine(
  (data) => {
    // travelers가 있으면 total 계산 및 검증
    if (data.travelers) {
      const total = data.travelers.adult + data.travelers.child + data.travelers.infant;
      if (total < 1 || total > 20) {
        return false;
      }
      // pax가 있으면 일치 여부 검증
      if (data.pax !== undefined && data.pax !== total) {
        return false;
      }
    } else {
      // travelers가 없으면 pax는 필수
      if (data.pax === undefined) {
        return false;
      }
      if (data.pax < 1 || data.pax > 20) {
        return false;
      }
    }
    return true;
  },
  {
    message: "travelers가 있으면 총 인원수(adult+child+infant)는 1~20명이어야 하며, pax와 일치해야 합니다. travelers가 없으면 pax는 필수이며 1~20명이어야 합니다.",
  }
);

export type ReservationsInput = z.infer<typeof reservationsSchema>;

/**
 * SSOT 6.2: Disabled dates (Query 파라미터)
 */
export const disabledDatesSchema = z.object({
  productId: z.string().min(1, "productId는 필수입니다."),
  from: dateSchema,
  to: dateSchema,
  poolKey: z.string().optional().default("DEFAULT"),
  bookingMode: z.enum(["private", "shared"]).optional().default("private"),
});

export type DisabledDatesInput = z.infer<typeof disabledDatesSchema>;

/**
 * SSOT 6.5: Cart Prepare (JSON body) - Phase 5-7
 */
export const cartPrepareSchema = z
  .object({
    productId: z.string().min(1, "productId는 필수입니다."),
    date: dateSchema,
    travelers: travelersSchema,
    bookingMode: z.enum(["private", "shared"]).optional().default("private"),
    poolKey: z.string().optional().default("DEFAULT"),
    guideUnitsRequired: z
      .union([z.string(), z.number()])
      .transform((val) => (typeof val === "string" ? Number(val) : val))
      .pipe(
        z
          .number()
          .int("guideUnitsRequired는 정수여야 합니다.")
          .min(1, "guideUnitsRequired는 최소 1이어야 합니다.")
          .max(10, "guideUnitsRequired는 최대 10까지 가능합니다.")
      )
      .optional()
      .default(1),
    holdId: z.string().optional(),
  })
  .refine(
    (data) => {
      const total = data.travelers.adult + data.travelers.child + data.travelers.infant;
      return total >= 1 && total <= 20;
    },
    {
      message: "총 인원수(adult+child+infant)는 1~20명이어야 합니다.",
    }
  );

export type CartPrepareInput = z.infer<typeof cartPrepareSchema>;

/**
 * TOUR Prepare Checkout (tour coupon issuance + cart + checkout)
 */
export const tourPrepareCheckoutSchema = z
  .object({
    productId: z.string().min(1, "productId는 필수입니다."),
    date: dateSchema,
    travelers: travelersSchema.optional(),
    variantId: z.string().optional(),
    quantity: z
      .union([z.string(), z.number()])
      .transform((val) => (typeof val === "string" ? Number(val) : val))
      .pipe(
        z
          .number()
          .int("quantity는 정수여야 합니다.")
          .min(1, "quantity는 최소 1이어야 합니다.")
          .max(20, "quantity는 최대 20까지 가능합니다.")
      )
      .optional(),
    bookingMode: z.enum(["private", "shared"]).optional().default("private"),
    poolKey: z.string().optional().default("DEFAULT"),
    guideUnitsRequired: z
      .union([z.string(), z.number()])
      .transform((val) => (typeof val === "string" ? Number(val) : val))
      .pipe(
        z
          .number()
          .int("guideUnitsRequired는 정수여야 합니다.")
          .min(1, "guideUnitsRequired는 최소 1이어야 합니다.")
          .max(10, "guideUnitsRequired는 최대 10까지 가능합니다.")
      )
      .optional()
      .default(1),
    holdId: z.string().optional(),
    properties: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    mediaConsent: z.boolean(),
    useTour15: z.boolean().optional().default(true),
    useExtra10: z.boolean().optional().default(false),
  })
  .refine(
    (data) => {
      if (data.variantId) {
        return Boolean(data.quantity && data.quantity >= 1);
      }
      if (!data.travelers) return false;
      const total =
        data.travelers.adult + data.travelers.child + data.travelers.infant;
      return total >= 1 && total <= 20;
    },
    {
      message:
        "variantId가 있으면 quantity가 필요합니다. variantId가 없으면 travelers가 필요하며 총 인원수는 1~20명이어야 합니다.",
    }
  );

export type TourPrepareCheckoutInput = z.infer<
  typeof tourPrepareCheckoutSchema
>;

/**
 * Guide Prepare Checkout (guide coupon application + checkout URL)
 */
export const guidePrepareCheckoutSchema = z.object({
  variantId: z.string().min(1, "variantId는 필수입니다."),
  quantity: z
    .union([z.string(), z.number()])
    .transform((val) => (typeof val === "string" ? Number(val) : val))
    .pipe(
      z
        .number()
        .int("quantity는 정수여야 합니다.")
        .refine((value) => value === 1, "quantity는 현재 1만 지원합니다.")
    ),
  useExtra10: z.boolean().optional().default(false),
  clientRequestId: z.string().min(1, "clientRequestId는 빈 문자열일 수 없습니다.").optional(),
});

export type GuidePrepareCheckoutInput = z.infer<
  typeof guidePrepareCheckoutSchema
>;

/**
 * SSOT 16.3: Rebuild (JSON body) - Phase 5-6R
 */
export const rebuildSchema = z.object({
  shop: z.string().optional(),
  ordersFrom: dateSchema,
  ordersTo: dateSchema,
  filterTravelFrom: dateSchema.optional(),
  filterTravelTo: dateSchema.optional(),
  mode: z.enum(["upsert", "replace"]).optional().default("upsert"),
  dryRun: z.boolean().optional().default(false),
});

export type RebuildInput = z.infer<typeof rebuildSchema>;

/**
 * 내부 backfill slot keys (JSON body)
 */
export const backfillSlotKeysSchema = z.object({
  shop: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
});

export type BackfillSlotKeysInput = z.infer<typeof backfillSlotKeysSchema>;

/**
 * Global blackout list (Internal/Admin)
 */
export const globalBlackoutListSchema = z.object({
  from: dateSchema,
  to: dateSchema,
  shop: z.string().optional(),
});

export type GlobalBlackoutListInput = z.infer<typeof globalBlackoutListSchema>;

/**
 * Global blackout toggle (Internal/Admin)
 */
export const globalBlackoutToggleSchema = z.object({
  date: dateSchema,
  note: z.string().optional(),
  shop: z.string().optional(),
});

export type GlobalBlackoutToggleInput = z.infer<typeof globalBlackoutToggleSchema>;

/**
 * Global blackout create (Internal/Admin)
 */
export const globalBlackoutCreateSchema = z.object({
  date: dateSchema,
  note: z.string().optional(),
  shop: z.string().optional(),
});

export type GlobalBlackoutCreateInput = z.infer<typeof globalBlackoutCreateSchema>;

/**
 * Global blackout update (Internal/Admin)
 */
export const globalBlackoutUpdateSchema = z
  .object({
    note: z.string().optional(),
    shop: z.string().optional(),
  })
  .refine((data) => typeof data.note === "string", {
    message: "note는 필수입니다.",
  });

export type GlobalBlackoutUpdateInput = z.infer<typeof globalBlackoutUpdateSchema>;

/**
 * Admin calendar list (Internal/Admin)
 */
export const adminCalendarSchema = z.object({
  from: dateSchema,
  to: dateSchema,
  productId: z.string().optional(),
  poolKey: z.string().optional(),
  shop: z.string().optional(),
});

export type AdminCalendarInput = z.infer<typeof adminCalendarSchema>;

/**
 * Admin refund (Internal/Admin)
 */
export const adminRefundSchema = z
  .object({
    mode: z.enum(["full", "partial"]),
    refundAttemptId: z.string().min(1, "refundAttemptId는 필수입니다."),
    items: z
      .array(
        z.object({
          lineItemId: z.string().min(1, "lineItemId는 필수입니다."),
          quantity: z.number().int().min(1, "quantity는 1 이상이어야 합니다."),
        })
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "partial" && (!data.items || data.items.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "부분 환불은 items가 필요합니다.",
      });
    }
  });

export type AdminRefundInput = z.infer<typeof adminRefundSchema>;

/**
 * Hold Release (JSON body)
 * holdId 필수, 검증용 필드들은 선택
 */
export const releaseHoldSchema = z.object({
  holdId: z.string().min(1, "holdId는 필수입니다."),
  productId: z.string().optional(),
  date: dateSchema.optional(),
  poolKey: z.string().optional(),
  bookingMode: z.enum(["private", "shared"]).optional(),
});

export type ReleaseHoldInput = z.infer<typeof releaseHoldSchema>;

/**
 * Admin Hold Release (Internal)
 */
export const adminHoldReleaseSchema = z.object({
  holdId: z.string().min(1, "holdId는 필수입니다."),
  reason: z.string().optional(),
  dryRun: z.boolean().optional(),
});

export type AdminHoldReleaseInput = z.infer<typeof adminHoldReleaseSchema>;

/**
 * Guide Extension Checkout (JSON body)
 */
export const guideExtensionCheckoutSchema = z.object({
  type: z.enum(["PDF", "VIDEO", "BUNDLE"]),
  months: z
    .number()
    .int("months는 정수여야 합니다.")
    .min(1, "months는 최소 1이어야 합니다.")
    .max(24, "months는 최대 24까지 가능합니다."),
});

export type GuideExtensionCheckoutInput = z.infer<
  typeof guideExtensionCheckoutSchema
>;

/**
 * Storefront mail request (App Proxy JSON/form body)
 */
export const storefrontMailRequestSchema = z.object({
  templateSlug: z
    .string()
    .trim()
    .min(1, "templateSlug는 필수입니다."),
  email: z
    .string()
    .trim()
    .email("올바른 이메일 형식이 아닙니다."),
  name: z
    .string()
    .trim()
    .max(100, "name은 최대 100자까지 가능합니다.")
    .optional(),
  pagePath: z
    .string()
    .trim()
    .max(500, "pagePath는 최대 500자까지 가능합니다.")
    .optional()
    .refine((value) => !value || value.startsWith("/"), {
      message: "pagePath는 / 로 시작해야 합니다.",
    }),
  recaptchaToken: z
    .string()
    .trim()
    .min(1, "recaptchaToken은 필수입니다."),
  requestKey: z
    .string()
    .trim()
    .max(191, "requestKey는 최대 191자까지 가능합니다.")
    .optional(),
  country: z
    .string()
    .trim()
    .max(100, "country는 최대 100자까지 가능합니다.")
    .optional(),
  consent: z
    .union([z.boolean(), z.string()])
    .transform((value) => {
      if (typeof value === "boolean") return value;
      const normalized = value.trim().toLowerCase();
      return (
        normalized === "true" ||
        normalized === "1" ||
        normalized === "yes" ||
        normalized === "on"
      );
    })
    .optional(),
  metaMarketingAllowed: z.boolean().optional().default(false),
});

export type StorefrontMailRequestInput = z.infer<
  typeof storefrontMailRequestSchema
>;

/**
 * Guide base purchase eligibility (App Proxy Query)
 */
export const guideBasePurchaseEligibilityQuerySchema = z.object({
  variantId: z.string().trim().min(1, "variantId는 필수입니다."),
});

export type GuideBasePurchaseEligibilityQueryInput = z.infer<
  typeof guideBasePurchaseEligibilityQuerySchema
>;

/**
 * Reviews list (App Proxy Query)
 */
export const reviewsListQuerySchema = z.object({
  productId: z
    .string()
    .trim()
    .min(1, "productId는 비어 있을 수 없습니다.")
    .optional(),
  reviewType: z.enum(["admin", "customer", "all"]).default("all"),
  placement: z.enum(["homepage", "product"]).optional(),
  sort: z.enum(["newest"]).default("newest"),
  limit: z
    .preprocess(
      (value) => {
        if (value === undefined || value === null || value === "") return undefined;
        const num = typeof value === "string" ? Number(value) : value;
        return Number.isNaN(num) ? value : num;
      },
      z
        .number()
        .int("limit는 정수여야 합니다.")
        .min(1, "limit는 최소 1이어야 합니다.")
        .max(50, "limit는 최대 50까지 가능합니다.")
        .optional()
        .default(20)
    ),
  cursor: z.string().optional(),
});

export type ReviewsListQueryInput = z.infer<typeof reviewsListQuerySchema>;

/**
 * Review create (App Proxy JSON body)
 */
export const reviewCreateBodySchema = z.object({
  reviewType: z.literal("customer"),
  productId: z.string().min(1, "productId는 필수입니다."),
  orderId: z.string().min(1, "orderId는 필수입니다."),
  body: z
    .string()
    .trim()
    .min(20, "body는 최소 20자 이상이어야 합니다.")
    .max(2000, "body는 최대 2000자까지 가능합니다."),
});

export type ReviewCreateBodyInput = z.infer<typeof reviewCreateBodySchema>;

export const reviewUpdateBodySchema = z.object({
  action: z.literal("update"),
  reviewId: z.string().min(1, "reviewId는 필수입니다."),
  orderId: z.string().min(1, "orderId는 필수입니다."),
  body: z
    .string()
    .trim()
    .min(20, "body는 최소 20자 이상이어야 합니다.")
    .max(2000, "body는 최대 2000자까지 가능합니다."),
});

export const reviewDeleteBodySchema = z.object({
  action: z.literal("delete"),
  reviewId: z.string().min(1, "reviewId는 필수입니다."),
  orderId: z.string().min(1, "orderId는 필수입니다."),
});

const shopifyCustomerGidPattern = /^gid:\/\/shopify\/Customer\/\d+$/;

/**
 * Review order status list (App Proxy Query)
 */
export const reviewOrderStatusQuerySchema = z.object({
  orderIds: z
    .array(
      z
        .string()
        .trim()
        .min(1, "orderId는 비어 있을 수 없습니다.")
    )
    .min(1, "orderIds는 최소 1개 이상이어야 합니다.")
    .max(50, "orderIds는 최대 50개까지 가능합니다."),
  loggedInCustomerId: z
    .string()
    .trim()
    .min(1, "logged_in_customer_id는 필수입니다.")
    .refine(
      (value) =>
        /^\d+$/.test(value) || shopifyCustomerGidPattern.test(value),
      "logged_in_customer_id 형식이 올바르지 않습니다."
    ),
});

export type ReviewOrderStatusQueryInput = z.infer<
  typeof reviewOrderStatusQuerySchema
>;

/**
 * 쿼리 파라미터를 객체로 변환하고 검증합니다.
 * productId, date, option, time은 항상 문자열로 유지하고,
 * pax와 guideUnitsRequired는 숫자로 변환합니다.
 */
export function parseQueryParams(url: URL): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  url.searchParams.forEach((value, key) => {
    // pax와 guideUnitsRequired는 숫자로 변환
    if (key === "pax" || key === "guideUnitsRequired") {
      const numValue = Number(value);
      params[key] = isNaN(numValue) ? value : numValue;
    } else {
      params[key] = value;
    }
  });
  return params;
}

/**
 * Slot key를 생성합니다.
 * 형식: slot:{productId}:{date}:{time}:{option}
 * time과 option은 선택적이며, 없으면 빈 문자열로 처리됩니다.
 */
export function generateSlotKey(params: {
  productId: string;
  date: string;
  time?: string;
  option?: string;
}): string {
  const timePart = params.time || "";
  const optionPart = params.option || "";
  return `slot:${params.productId}:${params.date}:${timePart}:${optionPart}`;
}
