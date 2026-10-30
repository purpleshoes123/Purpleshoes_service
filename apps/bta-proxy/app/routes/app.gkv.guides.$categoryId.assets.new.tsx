import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { AssetEditorPage } from "~/domains/guide-viewer/adminAssetEditorRoute";
import {
  createAssetEditorAction,
  createAssetEditorLoader,
} from "~/domains/guide-viewer/adminAssetEditorRoute.server.ts";

type DomainKey = "pdf" | "video";

function resolveDomain(request: Request): DomainKey | null {
  const kind = new URL(request.url).searchParams.get("kind")?.trim().toLowerCase() || "pdf";
  if (kind === "pdf" || kind === "video") {
    return kind;
  }
  return null;
}

const lockedCategoryOptions = {
  lockedCategoryParam: "categoryId",
  returnPath: "/app/gkv/guides",
  source: "guides" as const,
};

export const loader = async (args: LoaderFunctionArgs) => {
  const domain = resolveDomain(args.request);
  if (!domain) {
    return json({ ok: false, message: "kind는 pdf 또는 video여야 합니다." }, { status: 400 });
  }

  return createAssetEditorLoader(domain, "new", lockedCategoryOptions)(args);
};

export const action = async (args: ActionFunctionArgs) => {
  const domain = resolveDomain(args.request);
  if (!domain) {
    return json({ ok: false, message: "kind는 pdf 또는 video여야 합니다." }, { status: 400 });
  }

  return createAssetEditorAction(domain, "new", lockedCategoryOptions)(args);
};

export default function GkvGuideCategoryAssetNewPage() {
  return <AssetEditorPage />;
}
