import { z } from "zod";
import type {
  BookingMode,
  FileMeta,
  PriceTable,
  TicketType,
  TravelProductUpsertInput,
  TravelProductUpsertRequest,
  Weekday,
} from "./types";

const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const TICKET_TYPES: TicketType[] = ["adult", "child", "infant"];
const MAX_LIST_ITEMS = 3;

const formatListWithEllipsis = (items: string[]) => {
  if (items.length <= MAX_LIST_ITEMS) {
    return items.join(", ");
  }
  return `${items.slice(0, MAX_LIST_ITEMS).join(", ")}, ...`;
};

const dateSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: "blackoutDates는 YYYY-MM-DD 형식이어야 합니다.",
  });

const fileMetaSchema: z.ZodType<FileMeta> = z.object({
  filename: z.string().min(1, "filename은 필수입니다."),
  mimeType: z.enum(["image/jpeg", "image/png"], {
    message: "mimeType은 image/jpeg 또는 image/png여야 합니다.",
  }),
  sizeBytes: z
    .number()
    .int("sizeBytes는 정수여야 합니다.")
    .min(0, "sizeBytes는 0 이상이어야 합니다.")
    .max(20 * 1024 * 1024, "sizeBytes는 20MB 이하여야 합니다."),
});

const priceTableCellSchema = z.object({
  ticketType: z.enum(["adult", "child", "infant"]),
  unitPrice: z
    .number()
    .int("unitPrice는 정수여야 합니다.")
    .min(0, "unitPrice는 0 이상이어야 합니다."),
});

const priceTableTierSchema = z.object({
  paxTier: z.number().int().min(1, "paxTier는 1 이상이어야 합니다."),
  cells: z.array(priceTableCellSchema),
});

const priceTableSchema: z.ZodType<PriceTable> = z
  .object({
    tiers: z.array(priceTableTierSchema).min(1, "tiers는 최소 1개 이상이어야 합니다."),
  })
  .superRefine((value, ctx) => {
    const tiers = value.tiers;
    const tierNumbers = tiers.map((tier) => tier.paxTier);
    const uniqueTiers = new Set(tierNumbers);

    if (uniqueTiers.size !== tierNumbers.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tiers에 중복된 paxTier가 있습니다.",
      });
    }

    const sorted = Array.from(uniqueTiers).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tiers는 1..N 연속이어야 합니다.",
        });
        break;
      }
    }

    for (const tier of tiers) {
      const ticketTypes = tier.cells.map((cell) => cell.ticketType);
      const missing = TICKET_TYPES.filter((type) => !ticketTypes.includes(type));
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `paxTier ${tier.paxTier}에 ${missing.join(", ")} 가격이 필요합니다.`,
        });
      }
    }
  });

const baseSchema = z
  .object({
    externalKey: z.string().min(1, "externalKey는 필수입니다."),
    title: z.string().min(1, "title은 필수입니다."),
    descriptionHtml: z.string().optional().default(""),
    maxPax: z.number().int("maxPax는 정수여야 합니다.").min(1, "maxPax는 1 이상이어야 합니다."),
    bookingMode: z.enum(["private", "shared"]) as z.ZodType<BookingMode>,
    poolKey: z.string().min(1, "poolKey는 필수입니다."),
    guideUnitsRequired: z
      .number()
      .int("guideUnitsRequired는 정수여야 합니다.")
      .min(1, "guideUnitsRequired는 1 이상이어야 합니다."),
    startTimeLabel: z.string().min(1, "startTimeLabel은 필수입니다."),
    bookingWindowDays: z
      .number()
      .int("bookingWindowDays는 정수여야 합니다.")
      .min(0, "bookingWindowDays는 0 이상이어야 합니다."),
    operatingWeekdays: z
      .array(z.enum(WEEKDAYS))
      .min(1, "operatingWeekdays는 최소 1개 이상이어야 합니다.")
      .superRefine((value, ctx) => {
        const unique = new Set(value);
        if (unique.size !== value.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "operatingWeekdays에 중복된 값이 있습니다.",
          });
        }
      }),
    blackoutDates: z.array(dateSchema).superRefine((value, ctx) => {
      const unique = new Set(value);
      if (unique.size !== value.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "blackoutDates에 중복된 값이 있습니다.",
        });
      }
    }),
    pricingTable: priceTableSchema,
    heroMedia: fileMetaSchema.optional(),
    categoryImage: fileMetaSchema.optional(),
    travelGallery: z.array(fileMetaSchema).max(10).optional(),
    publicationIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const relaxedFilesSchema = z
  .object({
    externalKey: z.string().min(1, "externalKey는 필수입니다."),
    title: z.string().min(1, "title은 필수입니다."),
    descriptionHtml: z.string().optional().default(""),
    maxPax: z.number().int("maxPax는 정수여야 합니다.").min(1, "maxPax는 1 이상이어야 합니다."),
    bookingMode: z.enum(["private", "shared"]) as z.ZodType<BookingMode>,
    poolKey: z.string().min(1, "poolKey는 필수입니다."),
    guideUnitsRequired: z
      .number()
      .int("guideUnitsRequired는 정수여야 합니다.")
      .min(1, "guideUnitsRequired는 1 이상이어야 합니다."),
    startTimeLabel: z.string().min(1, "startTimeLabel은 필수입니다."),
    bookingWindowDays: z
      .number()
      .int("bookingWindowDays는 정수여야 합니다.")
      .min(0, "bookingWindowDays는 0 이상이어야 합니다."),
    operatingWeekdays: z
      .array(z.enum(WEEKDAYS))
      .min(1, "operatingWeekdays는 최소 1개 이상이어야 합니다.")
      .superRefine((value, ctx) => {
        const unique = new Set(value);
        if (unique.size !== value.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "operatingWeekdays에 중복된 값이 있습니다.",
          });
        }
      }),
    blackoutDates: z.array(dateSchema).superRefine((value, ctx) => {
      const unique = new Set(value);
      if (unique.size !== value.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "blackoutDates에 중복된 값이 있습니다.",
        });
      }
    }),
    pricingTable: priceTableSchema,
    heroMedia: fileMetaSchema.optional(),
    categoryImage: fileMetaSchema.optional(),
    travelGallery: z.array(fileMetaSchema).max(10).optional(),
    publicationIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const withPricingRefine = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const { maxPax, pricingTable } = value;
    const tiers = pricingTable.tiers;
    const tierNumbers = tiers.map((tier) => tier.paxTier);
    const tierSet = new Set(tierNumbers);

    const missingTiers: string[] = [];
    for (let i = 1; i <= maxPax; i += 1) {
      if (!tierSet.has(i)) {
        missingTiers.push(String(i));
      }
    }

    const missingCells: string[] = [];
    const invalidPrices: string[] = [];
    for (const tier of tiers) {
      const cellTypes = new Set<TicketType>();
      for (const cell of tier.cells) {
        cellTypes.add(cell.ticketType);
        if (
          !Number.isFinite(cell.unitPrice) ||
          !Number.isInteger(cell.unitPrice) ||
          cell.unitPrice < 0
        ) {
          invalidPrices.push(`(paxTier ${tier.paxTier}, ${cell.ticketType})`);
        }
      }
      const missingTypes = TICKET_TYPES.filter((type) => !cellTypes.has(type));
      for (const type of missingTypes) {
        missingCells.push(`(paxTier ${tier.paxTier}, ${type})`);
      }
    }

    if (missingTiers.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `누락된 paxTier: ${formatListWithEllipsis(missingTiers)}`,
      });
    }

    if (missingCells.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `누락된 가격 셀: ${formatListWithEllipsis(missingCells)}`,
      });
    }

    if (invalidPrices.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `음수/NaN 가격: ${formatListWithEllipsis(invalidPrices)}`,
      });
    }
  });

export const TravelProductUpsertSchema: z.ZodType<TravelProductUpsertInput> =
  withPricingRefine(baseSchema);

export const TravelProductUpsertRequestSchema: z.ZodType<TravelProductUpsertRequest> =
  withPricingRefine(relaxedFilesSchema);

export type TravelProductUpsertSchemaType = z.infer<typeof TravelProductUpsertSchema>;
export type TravelProductUpsertRequestSchemaType = z.infer<typeof TravelProductUpsertRequestSchema>;
