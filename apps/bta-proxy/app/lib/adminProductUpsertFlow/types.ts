import type { UploadInput } from "~/lib/adminFileUpload/types";
import type { TravelProductUpsertRequest } from "~/lib/adminProductUpsert/types";
import type { StepEntry } from "~/lib/adminProductUpsertFlow/stepLog";

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
