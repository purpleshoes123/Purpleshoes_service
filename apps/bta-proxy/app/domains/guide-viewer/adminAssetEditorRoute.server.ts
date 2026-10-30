import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { redirect } from "react-router";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";
import { withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";
import { uploadObjectToS3 } from "~/domains/guide-viewer/uploadUrl.server.ts";

type DomainKey = "pdf" | "video";

type DomainConfig = {
  domain: DomainKey;
  label: string;
  mainUploadKind: "PDF" | "VIDEO";
  mainMimeType: "application/pdf" | "video/mp4";
  accept: string;
  listPath: string;
  apiBase: string;
};

type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  depth: number;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
};

type AssetItem = {
  id: string;
  title: string;
  description: string | null;
  isActive: boolean;
  file: {
    assetId: string;
    s3Bucket: string;
    s3Key: string;
    mimeType: string;
    sizeBytes: number | null;
    status: "READY" | "UPLOADING" | "FAILED";
  };
  thumbnail: {
    s3Bucket: string | null;
    s3Key: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    status: "READY";
  } | null;
  categoryIds: string[];
};

type LoaderData = {
  mode: "new" | "edit";
  config: DomainConfig;
  item: AssetItem | null;
  categories: CategoryItem[];
  lockedCategory?: {
    id: string;
    path: string;
    returnPath: string;
    source: "guides";
  };
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
  id?: string;
  upload?: {
    assetId: string;
    uploadUrl: string;
    s3Bucket: string;
    s3Key: string;
    mode?: "placeholder" | "s3_presign";
  };
  multipartUpload?: {
    assetId: string;
    s3Bucket: string;
    s3Key: string;
    uploadToken: string;
    partSizeBytes: number;
    partCount: number;
    mode: "s3_multipart";
  };
  multipartPartUrls?: Array<{
    partNumber: number;
    uploadUrl: string;
  }>;
  multipartCompleted?: {
    sizeBytes: number;
  };
  fieldErrors?: Record<string, string>;
};

type AssetEditorRouteOptions = {
  lockedCategoryParam?: string;
  returnPath?: string;
  source?: "guides";
};

function getDomainConfig(domain: DomainKey): DomainConfig {
  if (domain === "pdf") {
    return {
      domain,
      label: "PDF",
      mainUploadKind: "PDF",
      mainMimeType: "application/pdf",
      accept: ".pdf,application/pdf",
      listPath: "/app/gkv/pdf",
      apiBase: "/admin/pdf",
    };
  }

  return {
    domain,
    label: "Video",
    mainUploadKind: "VIDEO",
    mainMimeType: "video/mp4",
    accept: "video/mp4,video/*",
    listPath: "/app/gkv/video",
    apiBase: "/admin/video",
  };
}

function buildCategoryPath(categories: CategoryItem[], categoryId: string): string {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const names: string[] = [];
  const visited = new Set<string>();
  let cursorId: string | null = categoryId;

  while (cursorId) {
    if (visited.has(cursorId)) {
      break;
    }
    visited.add(cursorId);
    const current = byId.get(cursorId);
    if (!current) {
      break;
    }
    names.push(current.name);
    cursorId = current.parentId;
  }

  return names.reverse().join(" / ");
}

function getLockedCategoryId(
  params: LoaderFunctionArgs["params"],
  options?: AssetEditorRouteOptions,
) {
  if (!options?.lockedCategoryParam) {
    return "";
  }
  return String(params[options.lockedCategoryParam] || "").trim();
}

export function createAssetEditorLoader(
  domain: DomainKey,
  mode: "new" | "edit",
  options?: AssetEditorRouteOptions,
) {
  const config = getDomainConfig(domain);

  return async ({ request, params }: LoaderFunctionArgs) => {
    await requireGkvAdmin(request);
    try {
      const lockedCategoryId = getLockedCategoryId(params, options);
      const categoriesPromise = callGkvAdminApi<{ items: CategoryItem[] }>(
        request,
        `${config.apiBase}/categories?includeInactive=true`,
      );

      const itemPromise =
        mode === "edit" && params.id
          ? callGkvAdminApi<{ item: AssetItem }>(request, `${config.apiBase}/assets/${params.id}`)
          : Promise.resolve<{ item: AssetItem } | null>(null);

      const [categoriesRes, itemRes] = await Promise.all([categoriesPromise, itemPromise]);
      const lockedCategory = lockedCategoryId
        ? categoriesRes.items.find((category) => category.id === lockedCategoryId)
        : undefined;

      if (options?.lockedCategoryParam && !lockedCategoryId) {
        return redirect(
          withEmbeddedSearch(options.returnPath ?? config.listPath, new URL(request.url).search),
        );
      }

      if (lockedCategoryId && !lockedCategory) {
        return redirect(
          withEmbeddedSearch(options?.returnPath ?? config.listPath, new URL(request.url).search),
        );
      }

      return json<LoaderData>({
        mode,
        config,
        item: itemRes?.item ?? null,
        categories: categoriesRes.items,
        ...(lockedCategory
          ? {
              lockedCategory: {
                id: lockedCategory.id,
                path:
                  buildCategoryPath(categoriesRes.items, lockedCategory.id) || lockedCategory.name,
                returnPath: options?.returnPath ?? config.listPath,
                source: options?.source ?? "guides",
              },
            }
          : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `${config.label} 데이터를 불러오지 못했습니다.`;
      return json<LoaderData>({
        mode,
        config,
        item: null,
        categories: [],
        error: message,
      });
    }
  };
}

export function createAssetEditorAction(
  domain: DomainKey,
  mode: "new" | "edit",
  options?: AssetEditorRouteOptions,
) {
  const config = getDomainConfig(domain);

  return async ({ request, params }: ActionFunctionArgs) => {
    await requireGkvAdmin(request);
    try {
      const formData = await request.formData();
      const intent = String(formData.get("intent") || "");
      const lockedCategoryId = getLockedCategoryId(params, options);

      if (intent === "prepare-upload") {
        const kind = String(formData.get("kind") || "");
        const fileName = String(formData.get("fileName") || "");
        const mimeType = String(formData.get("mimeType") || "");

        const upload = await callGkvAdminApi<{
          assetId: string;
          uploadUrl: string;
          s3Bucket: string;
          s3Key: string;
          mode?: "placeholder" | "s3_presign";
        }>(request, `${config.apiBase}/upload-url`, {
          method: "POST",
          body: JSON.stringify({ kind, fileName, mimeType }),
        });

        return json<ActionData>({
          ok: true,
          message: "업로드 URL을 발급했습니다.",
          upload,
        });
      }

      if (intent === "prepare-multipart-upload") {
        if (domain !== "video") {
          return json<ActionData>(
            { ok: false, message: "대용량 multipart upload는 영상에만 사용할 수 있습니다." },
            { status: 400 },
          );
        }

        const multipartUpload = await callGkvAdminApi<ActionData["multipartUpload"]>(
          request,
          `${config.apiBase}/upload-multipart`,
          {
            method: "POST",
            body: JSON.stringify({
              intent: "start",
              kind: "VIDEO",
              fileName: String(formData.get("fileName") || ""),
              mimeType: String(formData.get("mimeType") || ""),
              fileSizeBytes: Number(formData.get("fileSizeBytes") || 0),
            }),
          },
        );

        if (!multipartUpload) {
          throw new Error("multipart upload 시작 응답이 비어 있습니다.");
        }
        return json<ActionData>({ ok: true, multipartUpload });
      }

      if (intent === "sign-multipart-parts") {
        if (domain !== "video") {
          return json<ActionData>(
            { ok: false, message: "영상 upload가 아닙니다." },
            { status: 400 },
          );
        }

        const multipartPartUrls = await callGkvAdminApi<{
          parts: NonNullable<ActionData["multipartPartUrls"]>;
        }>(request, `${config.apiBase}/upload-multipart`, {
          method: "POST",
          body: JSON.stringify({
            intent: "sign-parts",
            uploadToken: String(formData.get("uploadToken") || ""),
            partNumbers: JSON.parse(String(formData.get("partNumbers") || "[]")),
          }),
        });

        return json<ActionData>({ ok: true, multipartPartUrls: multipartPartUrls.parts });
      }

      if (intent === "complete-multipart-upload") {
        if (domain !== "video") {
          return json<ActionData>(
            { ok: false, message: "영상 upload가 아닙니다." },
            { status: 400 },
          );
        }

        const multipartCompleted = await callGkvAdminApi<ActionData["multipartCompleted"]>(
          request,
          `${config.apiBase}/upload-multipart`,
          {
            method: "POST",
            body: JSON.stringify({
              intent: "complete",
              uploadToken: String(formData.get("uploadToken") || ""),
              parts: JSON.parse(String(formData.get("parts") || "[]")),
            }),
          },
        );

        if (!multipartCompleted) {
          throw new Error("multipart upload 완료 응답이 비어 있습니다.");
        }
        return json<ActionData>({ ok: true, multipartCompleted });
      }

      if (intent === "abort-multipart-upload") {
        if (domain !== "video") {
          return json<ActionData>(
            { ok: false, message: "영상 upload가 아닙니다." },
            { status: 400 },
          );
        }

        await callGkvAdminApi<{ aborted: boolean }>(request, `${config.apiBase}/upload-multipart`, {
          method: "POST",
          body: JSON.stringify({
            intent: "abort",
            uploadToken: String(formData.get("uploadToken") || ""),
          }),
        });
        return json<ActionData>({ ok: true });
      }

      if (intent === "upload-via-server") {
        const s3Bucket = String(formData.get("s3Bucket") || "").trim();
        const s3Key = String(formData.get("s3Key") || "").trim();
        const mimeType = String(formData.get("mimeType") || "application/octet-stream").trim();
        const fileValue = formData.get("file");

        if (!s3Bucket || !s3Key) {
          return json<ActionData>(
            { ok: false, message: "s3Bucket/s3Key가 필요합니다." },
            { status: 400 },
          );
        }
        if (!(fileValue instanceof Blob)) {
          return json<ActionData>(
            { ok: false, message: "업로드할 파일이 필요합니다." },
            { status: 400 },
          );
        }

        await uploadObjectToS3({
          s3Bucket,
          s3Key,
          mimeType: mimeType || fileValue.type || "application/octet-stream",
          body: new Uint8Array(await fileValue.arrayBuffer()),
        });

        return json<ActionData>({ ok: true, message: "서버 경유 업로드를 완료했습니다." });
      }

      if (intent === "create-category") {
        const depth = Number(formData.get("depth") || 1);
        const result = await callGkvAdminApi<{ id: string }>(
          request,
          `${config.apiBase}/categories`,
          {
            method: "POST",
            body: JSON.stringify({
              name: String(formData.get("name") || ""),
              slug: String(formData.get("slug") || ""),
              depth,
              parentId: String(formData.get("parentId") || "") || undefined,
              sortOrder: Number(formData.get("sortOrder") || 0),
              isActive: String(formData.get("isActive") || "true") === "true",
            }),
          },
        );
        return json<ActionData>({ ok: true, id: result.id, message: "카테고리를 생성했습니다." });
      }

      if (intent === "update-category") {
        const categoryId = String(formData.get("categoryId") || "").trim();
        if (!categoryId) {
          return json<ActionData>(
            { ok: false, message: "category id가 필요합니다." },
            { status: 400 },
          );
        }

        const payload: Record<string, unknown> = {};
        const name = formData.get("name");
        if (name !== null) {
          payload.name = String(name);
        }
        const slug = formData.get("slug");
        if (slug !== null) {
          payload.slug = String(slug);
        }
        const depth = String(formData.get("depth") || "").trim();
        if (depth) {
          payload.depth = Number(depth);
        }
        if (formData.has("parentId")) {
          const parentId = String(formData.get("parentId") || "").trim();
          payload.parentId = parentId.length > 0 ? parentId : null;
        }
        const sortOrder = String(formData.get("sortOrder") || "").trim();
        if (sortOrder) {
          payload.sortOrder = Number(sortOrder);
        }
        if (formData.has("isActive")) {
          payload.isActive = String(formData.get("isActive") || "true") === "true";
        }

        if (Object.keys(payload).length === 0) {
          return json<ActionData>(
            { ok: false, message: "수정할 항목이 없습니다." },
            { status: 400 },
          );
        }

        await callGkvAdminApi<{ id: string; updated: boolean }>(
          request,
          `${config.apiBase}/categories/${categoryId}`,
          {
            method: "PUT",
            body: JSON.stringify(payload),
          },
        );

        return json<ActionData>({ ok: true, id: categoryId, message: "카테고리를 수정했습니다." });
      }

      if (intent === "delete-category") {
        const categoryId = String(formData.get("categoryId") || "").trim();
        if (!categoryId) {
          return json<ActionData>(
            { ok: false, message: "category id가 필요합니다." },
            { status: 400 },
          );
        }

        await callGkvAdminApi<{ id: string; deleted: boolean }>(
          request,
          `${config.apiBase}/categories/${categoryId}`,
          {
            method: "DELETE",
          },
        );

        return json<ActionData>({ ok: true, id: categoryId, message: "카테고리를 삭제했습니다." });
      }

      if (intent === "save") {
        const payloadRaw = String(formData.get("payload") || "{}");
        const payload = JSON.parse(payloadRaw) as Record<string, unknown>;
        if (options?.lockedCategoryParam) {
          if (!lockedCategoryId) {
            return json<ActionData>(
              { ok: false, message: "category id가 필요합니다." },
              { status: 400 },
            );
          }
          payload.categoryIds = [lockedCategoryId];
        }

        const path =
          mode === "edit" ? `${config.apiBase}/assets/${params.id}` : `${config.apiBase}/assets`;
        const method = mode === "edit" ? "PUT" : "POST";

        const result = await callGkvAdminApi<{ id: string }>(request, path, {
          method,
          body: JSON.stringify(payload),
        });

        return json<ActionData>({
          ok: true,
          message: "저장을 완료했습니다.",
          id: result.id,
        });
      }

      if (intent === "delete-asset") {
        if (!params.id) {
          return json<ActionData>(
            { ok: false, message: "asset id가 필요합니다." },
            { status: 400 },
          );
        }

        await callGkvAdminApi<{ id: string; deleted: boolean }>(
          request,
          `${config.apiBase}/assets/${params.id}`,
          {
            method: "DELETE",
          },
        );

        return json<ActionData>({ ok: true, message: "삭제를 완료했습니다." });
      }

      return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
    } catch (error) {
      if (error instanceof GkvAdminApiError) {
        const safeStatus = error.status >= 400 ? error.status : 502;
        const location =
          (error.details?.location as string | undefined) ??
          (error.details?.redirectLocation as string | undefined);
        const message =
          error.code === "ADMIN_API_REDIRECT" && location
            ? `${error.message} (${location})`
            : error.message;
        return json<ActionData>(
          {
            ok: false,
            message,
            fieldErrors:
              (error.details?.fieldErrors as Record<string, string> | undefined) ?? undefined,
          },
          { status: safeStatus },
        );
      }

      const message = error instanceof Error ? error.message : "요청 처리에 실패했습니다.";
      return json<ActionData>({ ok: false, message }, { status: 500 });
    }
  };
}
