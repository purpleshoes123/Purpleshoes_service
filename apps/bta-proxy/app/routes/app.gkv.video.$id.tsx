import { AssetEditorPage } from "~/domains/guide-viewer/adminAssetEditorRoute";
import {
  createAssetEditorAction,
  createAssetEditorLoader,
} from "~/domains/guide-viewer/adminAssetEditorRoute.server.ts";

export const loader = createAssetEditorLoader("video", "edit");
export const action = createAssetEditorAction("video", "edit");

export default function GkvVideoEditPage() {
  return <AssetEditorPage />;
}
