// Phase 4 scaffold (Create Draft only)
export type {
  DraftCreateInput,
  DraftCreateResult,
} from "~/domains/catalog/adminProductWriteDraft/types";
export { createDraftProductBase } from "~/domains/catalog/adminProductWriteDraft/createDraftProductBase";
export { setExternalKeyMetafield } from "~/domains/catalog/adminProductWriteDraft/setExternalKeyMetafield";
export { createDraftBaseProductWithExternalKey } from "~/domains/catalog/adminProductWriteDraft/createDraftBaseProductWithExternalKey";
export { decideUpsertMode } from "~/domains/catalog/adminProductWriteDraft/decideUpsertMode";
