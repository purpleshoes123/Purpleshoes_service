import { AssetEditorPage } from "~/lib/gkv/adminAssetEditorRoute";
import { createAssetEditorAction, createAssetEditorLoader } from "~/lib/gkv/adminAssetEditorRoute.server";

export const loader = createAssetEditorLoader("video", "edit");
export const action = createAssetEditorAction("video", "edit");

export default function GkvVideoEditPage() {
  return <AssetEditorPage />;
}
