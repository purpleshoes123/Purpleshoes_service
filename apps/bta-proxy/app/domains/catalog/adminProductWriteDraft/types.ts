import type { TravelProductUpsertInput } from "~/domains/catalog/adminProductUpsert/types";

export type DraftCreateInput = Pick<
  TravelProductUpsertInput,
  "externalKey" | "title" | "descriptionHtml"
> & {
  taxonomyPublicId?: string;
};

export type DraftCreateResult = {
  productId: string;
  handle?: string;
  status?: string;
};
