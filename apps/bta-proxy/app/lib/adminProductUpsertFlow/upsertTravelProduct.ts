import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ZodError } from "zod";

import { uploadImageToShopifyFiles } from "~/lib/adminFileUpload/uploadImage";
import { attachHeroMedia } from "~/lib/adminProductAttachFiles/attachHeroMedia";
import { attachMetafieldsOnly } from "~/lib/adminProductAttachFiles/attachMetafieldsOnly";
import { TravelProductUpsertRequestSchema } from "~/lib/adminProductUpsert/inputSchema";
import {
  normalizeBlackoutDates,
  normalizeWeekdays,
} from "~/lib/adminProductUpsert/normalize";
import {
  createDraftBaseProductWithExternalKey,
} from "~/lib/adminProductWriteDraft/createDraftBaseProductWithExternalKey";
import { publishOrchestrator } from "~/lib/adminPublishProduct";
import { assertPublicationAccess } from "~/lib/adminPublishProduct/assertPublicationAccess";
import { toTierPriceMatrix, upsertTierVariants } from "~/lib/adminVariantUpsert";
import { fetchProductIdByExternalKey } from "~/lib/adminProductUpsertFlow/fetchProductIdByExternalKey";
import { updateBaseFields } from "~/lib/adminProductUpsertFlow/updateBaseFields";
import { StepLogger, wrapErrorWithSteps } from "~/lib/adminProductUpsertFlow/stepLog";
import type {
  UpsertTravelProductInput,
  UpsertTravelProductResult,
} from "~/lib/adminProductUpsertFlow/types";

type UpsertOptions = {
  publish?: boolean;
};

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => issue.message).join(", ");
}

export async function upsertTravelProduct(
  adminClient: AdminApiContext,
  input: UpsertTravelProductInput,
  options: UpsertOptions = {}
): Promise<UpsertTravelProductResult> {
  const steps = new StepLogger();
  let productId = "";
  let mode: UpsertTravelProductResult["mode"] = "CREATE";

  const {
    heroFile,
    categoryImageFile,
    travelGalleryFiles,
    ...requestPayload
  } = input;

  const parsed = TravelProductUpsertRequestSchema.safeParse(requestPayload);
  if (!parsed.success) {
    const message = formatZodError(parsed.error);
    const error = new Error(`입력값 검증 실패: ${message}`);
    steps.addFail("validateInput", error);
    throw wrapErrorWithSteps(error, steps.toResult());
  }
  const normalized = {
    ...parsed.data,
    operatingWeekdays: normalizeWeekdays(parsed.data.operatingWeekdays),
    blackoutDates: normalizeBlackoutDates(parsed.data.blackoutDates),
  };
  steps.addOk("validateInput");

  const publicationIds = normalized.publicationIds ?? [];
  if (options.publish && publicationIds.length === 0) {
    const error = new Error("게시할 판매 채널을 먼저 선택해 주세요. 상품은 변경되지 않았습니다.");
    steps.addFail("validatePublishChannels", error);
    throw wrapErrorWithSteps(error, steps.toResult());
  }

  if (options.publish) {
    try {
      await assertPublicationAccess(adminClient);
      steps.addOk("validatePublishAccess");
    } catch (error) {
      steps.addFail("validatePublishAccess", error);
      throw wrapErrorWithSteps(error, steps.toResult());
    }
  }

  let existingId: string | null = null;
  try {
    existingId = await fetchProductIdByExternalKey(
      adminClient,
      normalized.externalKey
    );
    mode = existingId ? "UPDATE" : "CREATE";
    steps.addOk("decideUpsertMode", { mode });
  } catch (error) {
    steps.addFail("decideUpsertMode", error);
    throw wrapErrorWithSteps(error, steps.toResult());
  }

  if (mode === "CREATE") {
    try {
      const result = await createDraftBaseProductWithExternalKey(adminClient, {
        externalKey: normalized.externalKey,
        title: normalized.title,
        descriptionHtml: normalized.descriptionHtml,
      });
      productId = result.productId;
      steps.addOk("createDraftBaseProduct", { productId });
    } catch (error) {
      steps.addFail("createDraftBaseProduct", error);
      throw wrapErrorWithSteps(error, steps.toResult());
    }
  } else {
    if (!existingId) {
      const error = new Error("UPDATE 대상 productId를 찾을 수 없습니다.");
      steps.addFail("fetchProductId", error);
      throw wrapErrorWithSteps(error, steps.toResult());
    }
    productId = existingId;
    steps.addOk("fetchProductId", { productId });

    try {
      await updateBaseFields(adminClient, productId, {
        title: normalized.title,
        descriptionHtml: normalized.descriptionHtml,
      });
      steps.addOk("updateBaseFields");
    } catch (error) {
      steps.addFail("updateBaseFields", error);
      throw wrapErrorWithSteps(error, steps.toResult(), { productId });
    }
  }

  let heroFileId: string | undefined;
  let heroPreviewUrl: string | undefined;
  let categoryImageFileId: string | undefined;
  let galleryFileIds: string[] | undefined;

  if (heroFile) {
    try {
      const result = await uploadImageToShopifyFiles(
        adminClient,
        heroFile,
        normalized.title
      );
      heroFileId = result.fileId;
      heroPreviewUrl = result.previewUrl || result.sourceUrl;
      if (!heroPreviewUrl) {
        throw new Error("hero media URL이 비어 있습니다.");
      }
      steps.addOk("uploadHeroMedia", { fileId: heroFileId });
    } catch (error) {
      steps.addFail("uploadHeroMedia", error);
      throw wrapErrorWithSteps(error, steps.toResult(), { productId });
    }
  }

  if (categoryImageFile) {
    try {
      const result = await uploadImageToShopifyFiles(
        adminClient,
        categoryImageFile,
        normalized.title
      );
      categoryImageFileId = result.fileId;
      steps.addOk("uploadCategoryImage", { fileId: categoryImageFileId });
    } catch (error) {
      steps.addFail("uploadCategoryImage", error);
      throw wrapErrorWithSteps(error, steps.toResult(), { productId });
    }
  }

  if (travelGalleryFiles && travelGalleryFiles.length > 0) {
    try {
      const ids: string[] = [];
      for (const file of travelGalleryFiles) {
        const result = await uploadImageToShopifyFiles(
          adminClient,
          file,
          normalized.title
        );
        ids.push(result.fileId);
      }
      galleryFileIds = ids;
      steps.addOk("uploadGalleryImages", { count: ids.length });
    } catch (error) {
      steps.addFail("uploadGalleryImages", error);
      throw wrapErrorWithSteps(error, steps.toResult(), { productId });
    }
  }

  if (heroPreviewUrl) {
    try {
      await attachHeroMedia(adminClient, productId, heroPreviewUrl);
      steps.addOk("attachHeroMedia");
    } catch (error) {
      steps.addFail("attachHeroMedia", error);
      throw wrapErrorWithSteps(error, steps.toResult(), { productId });
    }
  }

  try {
    await attachMetafieldsOnly(adminClient, {
      productId,
      categoryImageFileId,
      galleryFileIds,
      poolKey: normalized.poolKey,
      blackoutDates: normalized.blackoutDates,
      guideUnitsRequired: normalized.guideUnitsRequired,
      bookingMode: normalized.bookingMode,
      startTimeLabel: normalized.startTimeLabel,
      operatingWeekdays: normalized.operatingWeekdays,
      bookingWindowDays: normalized.bookingWindowDays,
      maxPax: normalized.maxPax,
    });
    steps.addOk("attachMetafieldsOnly");
  } catch (error) {
    steps.addFail("attachMetafieldsOnly", error);
    throw wrapErrorWithSteps(error, steps.toResult(), { productId });
  }

  try {
    const matrix = toTierPriceMatrix({
      maxPax: normalized.maxPax,
      pricingTable: normalized.pricingTable,
    });
    const variantResult = await upsertTierVariants(adminClient, productId, matrix);
    steps.addOk("upsertTierVariants", {
      created: variantResult.created,
      updated: variantResult.updated,
      deactivated: variantResult.deactivated,
    });
  } catch (error) {
    steps.addFail("upsertTierVariants", error);
    throw wrapErrorWithSteps(error, steps.toResult(), { productId });
  }

  let published = false;
  if (options.publish) {
    try {
      await publishOrchestrator(adminClient, {
        productId,
        publicationIds,
        maxPax: normalized.maxPax,
      });
      published = true;
      steps.addOk("publish", { publicationCount: publicationIds.length });
    } catch (error) {
      steps.addFail("publish", error);
      throw wrapErrorWithSteps(error, steps.toResult(), { productId });
    }
  }

  return {
    productId,
    mode,
    steps: steps.toResult(),
    published,
  };
}
