// Phase 4 scaffold (Create Draft only)
export type {
  DraftCreateInput,
  DraftCreateResult,
} from "~/lib/adminProductWriteDraft/types";
export { createDraftProductBase } from "~/lib/adminProductWriteDraft/createDraftProductBase";
export { setExternalKeyMetafield } from "~/lib/adminProductWriteDraft/setExternalKeyMetafield";
export {
  createDraftBaseProductWithExternalKey,
} from "~/lib/adminProductWriteDraft/createDraftBaseProductWithExternalKey";
export { decideUpsertMode } from "~/lib/adminProductWriteDraft/decideUpsertMode";
