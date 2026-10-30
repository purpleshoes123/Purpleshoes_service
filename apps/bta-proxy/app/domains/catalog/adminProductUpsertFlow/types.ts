import type { UploadInput } from "~/domains/catalog/adminFileUpload/types";
import type { TravelProductUpsertRequest } from "~/domains/catalog/adminProductUpsert/types";
import type { StepEntry } from "~/domains/catalog/adminProductUpsertFlow/stepLog";

export type UpsertTravelProductInput = TravelProductUpsertRequest & {
  heroFile?: UploadInput;
  categoryImageFile?: UploadInput;
  travelGalleryFiles?: UploadInput[];
};

export type UpsertTravelProductResult = {
  productId: string;
  mode: "CREATE" | "UPDATE";
  steps: StepEntry[];
  published: boolean;
};
