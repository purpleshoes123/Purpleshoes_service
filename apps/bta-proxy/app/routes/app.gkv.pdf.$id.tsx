import { AssetEditorPage } from "~/lib/gkv/adminAssetEditorRoute";
import { createAssetEditorAction, createAssetEditorLoader } from "~/lib/gkv/adminAssetEditorRoute.server";

export const loader = createAssetEditorLoader("pdf", "edit");
export const action = createAssetEditorAction("pdf", "edit");

export default function GkvPdfEditPage() {
  return <AssetEditorPage />;
}
