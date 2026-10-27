import { AssetEditorPage } from "~/lib/gkv/adminAssetEditorRoute";
import { createAssetEditorAction, createAssetEditorLoader } from "~/lib/gkv/adminAssetEditorRoute.server";

export const loader = createAssetEditorLoader("video", "new");
export const action = createAssetEditorAction("video", "new");

export default function GkvVideoNewPage() {
  return <AssetEditorPage />;
}
