export { upsertTravelProduct } from "~/lib/adminProductUpsertFlow/upsertTravelProduct";
export type {
  UpsertTravelProductInput,
  UpsertTravelProductResult,
} from "~/lib/adminProductUpsertFlow/types";

export { StepLogger, wrapErrorWithSteps } from "~/lib/adminProductUpsertFlow/stepLog";
export type { StepEntry } from "~/lib/adminProductUpsertFlow/stepLog";

export { fetchProductIdByExternalKey } from "~/lib/adminProductUpsertFlow/fetchProductIdByExternalKey";
export { setProductDraft } from "~/lib/adminProductUpsertFlow/setProductDraft";
export { updateBaseFields } from "~/lib/adminProductUpsertFlow/updateBaseFields";
export { generateExternalKey } from "~/lib/adminProductUpsertFlow/generateExternalKey";
export { auditLog } from "~/lib/adminProductUpsertFlow/auditLog";
