// Phase 3 scaffold (Write Files only)
export {
  UploadError,
  UploadErrorCode,
  type UploadInput,
  type UploadResult,
} from "~/domains/catalog/adminFileUpload/types";

export { validateUploadInput } from "~/domains/catalog/adminFileUpload/validate";
export { createStagedUploadTarget } from "~/domains/catalog/adminFileUpload/createStagedTarget";
export { uploadToStagedTarget } from "~/domains/catalog/adminFileUpload/uploadHttp";
export { createFileRecord } from "~/domains/catalog/adminFileUpload/createFileRecord";
export { uploadImageToShopifyFiles } from "~/domains/catalog/adminFileUpload/uploadImage";
