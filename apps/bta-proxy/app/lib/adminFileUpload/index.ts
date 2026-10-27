// Phase 3 scaffold (Write Files only)
export {
  UploadError,
  UploadErrorCode,
  type UploadInput,
  type UploadResult,
} from "~/lib/adminFileUpload/types";

export { validateUploadInput } from "~/lib/adminFileUpload/validate";
export { createStagedUploadTarget } from "~/lib/adminFileUpload/createStagedTarget";
export { uploadToStagedTarget } from "~/lib/adminFileUpload/uploadHttp";
export { createFileRecord } from "~/lib/adminFileUpload/createFileRecord";
export { uploadImageToShopifyFiles } from "~/lib/adminFileUpload/uploadImage";
