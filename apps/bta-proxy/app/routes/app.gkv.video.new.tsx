import { AssetEditorPage } from "~/domains/guide-viewer/adminAssetEditorRoute";
import {
  createAssetEditorAction,
  createAssetEditorLoader,
} from "~/domains/guide-viewer/adminAssetEditorRoute.server.ts";

export const loader = createAssetEditorLoader("video", "new");
export const action = createAssetEditorAction("video", "new");

export default function GkvVideoNewPage() {
  return <AssetEditorPage />;
}
