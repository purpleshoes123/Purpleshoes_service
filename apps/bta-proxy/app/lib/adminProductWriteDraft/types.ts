import type { TravelProductUpsertInput } from "~/lib/adminProductUpsert/types";

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
