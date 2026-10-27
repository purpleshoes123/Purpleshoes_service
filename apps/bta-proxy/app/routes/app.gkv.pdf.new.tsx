import { AssetEditorPage } from "~/lib/gkv/adminAssetEditorRoute";
import { createAssetEditorAction, createAssetEditorLoader } from "~/lib/gkv/adminAssetEditorRoute.server";

export const loader = createAssetEditorLoader("pdf", "new");
export const action = createAssetEditorAction("pdf", "new");

export default function GkvPdfNewPage() {
  return <AssetEditorPage />;
}
