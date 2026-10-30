import { AssetEditorPage } from "~/domains/guide-viewer/adminAssetEditorRoute";
import {
  createAssetEditorAction,
  createAssetEditorLoader,
} from "~/domains/guide-viewer/adminAssetEditorRoute.server.ts";

export const loader = createAssetEditorLoader("pdf", "edit");
export const action = createAssetEditorAction("pdf", "edit");

export default function GkvPdfEditPage() {
  return <AssetEditorPage />;
}
