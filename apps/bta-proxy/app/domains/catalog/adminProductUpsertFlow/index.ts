export { upsertTravelProduct } from "~/domains/catalog/adminProductUpsertFlow/upsertTravelProduct";
export type {
  UpsertTravelProductInput,
  UpsertTravelProductResult,
} from "~/domains/catalog/adminProductUpsertFlow/types";

export { StepLogger, wrapErrorWithSteps } from "~/domains/catalog/adminProductUpsertFlow/stepLog";
export type { StepEntry } from "~/domains/catalog/adminProductUpsertFlow/stepLog";

export { fetchProductIdByExternalKey } from "~/domains/catalog/adminProductUpsertFlow/fetchProductIdByExternalKey";
export { setProductDraft } from "~/domains/catalog/adminProductUpsertFlow/setProductDraft";
export { updateBaseFields } from "~/domains/catalog/adminProductUpsertFlow/updateBaseFields";
export { generateExternalKey } from "~/domains/catalog/adminProductUpsertFlow/generateExternalKey";
export { auditLog } from "~/domains/catalog/adminProductUpsertFlow/auditLog";
