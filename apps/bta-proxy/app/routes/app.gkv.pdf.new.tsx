import { AssetEditorPage } from "~/domains/guide-viewer/adminAssetEditorRoute";
import {
  createAssetEditorAction,
  createAssetEditorLoader,
} from "~/domains/guide-viewer/adminAssetEditorRoute.server.ts";

export const loader = createAssetEditorLoader("pdf", "new");
export const action = createAssetEditorAction("pdf", "new");

export default function GkvPdfNewPage() {
  return <AssetEditorPage />;
}
