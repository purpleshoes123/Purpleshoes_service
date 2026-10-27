import { useFetcher, useLoaderData, useLocation, useNavigate } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineGrid,
  InlineStack,
  List,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { withEmbeddedSearch } from "~/lib/gkv/embeddedPath";

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

type CategoryTreeNode = CategoryItem & { children: CategoryTreeNode[] };

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

function normalizeFieldError(error: unknown): { message: string; fieldErrors?: Record<string, string> } {
  if (error && typeof error === "object") {
    const maybe = error as {
      message?: string;
      fieldErrors?: Record<string, string>;
    };
    return {
      message: maybe.message ?? "요청 처리에 실패했습니다.",
      fieldErrors: maybe.fieldErrors,
    };
  }
  return { message: "요청 처리에 실패했습니다." };
}

function slugifyCategory(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

type PendingAction = {
  resolve: (value: ActionData) => void;
  reject: (reason: unknown) => void;
  started: boolean;
};

async function uploadFile(uploadUrl: string, file: File, onProgress: (percent: number) => void) {
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
      onProgress(percent);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`S3 업로드 실패 (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("S3 업로드 중 네트워크 오류가 발생했습니다."));
    xhr.send(file);
  });
}

const MULTIPART_SIGN_BATCH_SIZE = 20;
const MULTIPART_UPLOAD_CONCURRENCY = 3;
const MULTIPART_PART_RETRY_COUNT = 3;

async function uploadMultipartPart(
  uploadUrl: string,
  part: Blob,
  onProgress: (loadedBytes: number) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`S3 multipart part 업로드 실패 (${xhr.status})`));
        return;
      }

      const eTag = xhr.getResponseHeader("ETag");
      if (!eTag) {
        reject(new Error("S3 multipart part ETag를 읽지 못했습니다. S3 CORS ExposeHeaders 설정을 확인해 주세요."));
        return;
      }

      onProgress(part.size);
      resolve(eTag);
    };
    xhr.onerror = () => reject(new Error("S3 multipart part 업로드 중 네트워크 오류가 발생했습니다."));
    xhr.send(part);
  });
}

async function uploadMultipartPartWithRetry(
  uploadUrl: string,
  part: Blob,
  onProgress: (loadedBytes: number) => void
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MULTIPART_PART_RETRY_COUNT; attempt += 1) {
    try {
      return await uploadMultipartPart(uploadUrl, part, onProgress);
    } catch (error) {
      lastError = error;
      if (attempt < MULTIPART_PART_RETRY_COUNT) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("S3 multipart part 업로드에 실패했습니다.");
}

async function uploadFileViaServer(
  postEditorAction: (formData: FormData) => Promise<ActionData>,
  upload: {
    s3Bucket: string;
    s3Key: string;
  },
  file: File,
  mimeType: string,
  kind: "PDF" | "VIDEO" | "THUMBNAIL",
  onProgress: (percent: number) => void
) {
  onProgress(5);
  const fd = new FormData();
  fd.set("intent", "upload-via-server");
  fd.set("kind", kind);
  fd.set("s3Bucket", upload.s3Bucket);
  fd.set("s3Key", upload.s3Key);
  fd.set("mimeType", mimeType || file.type || "application/octet-stream");
  fd.set("file", file, file.name);
  await postEditorAction(fd);
  onProgress(100);
}

function buildCategoryTree(categories: CategoryItem[]): CategoryTreeNode[] {
  const byId = new Map<string, CategoryTreeNode>();
  for (const category of categories) {
    byId.set(category.id, { ...category, children: [] });
  }

  const roots: CategoryTreeNode[] = [];
  for (const category of categories) {
    const node = byId.get(category.id);
    if (!node) continue;
    if (category.parentId) {
      const parent = byId.get(category.parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  const sortNodes = (nodes: CategoryTreeNode[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}

function collectDescendantCategoryIds(categories: CategoryItem[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    const children = childrenByParent.get(category.parentId) ?? [];
    children.push(category.id);
    childrenByParent.set(category.parentId, children);
  }

  const ids: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || ids.includes(current)) continue;
    ids.push(current);
    const children = childrenByParent.get(current) ?? [];
    stack.push(...children);
  }
  return ids;
}

function upsertCategoryById(categories: CategoryItem[], next: CategoryItem): CategoryItem[] {
  const existingIndex = categories.findIndex((item) => item.id === next.id);
  if (existingIndex < 0) {
    return categories.concat(next);
  }

  const cloned = categories.slice();
  cloned[existingIndex] = { ...cloned[existingIndex], ...next };
  return cloned;
}

export function AssetEditorPage() {
  const { mode, config, item, categories, lockedCategory, error } = useLoaderData<LoaderData>();
  const actionFetcher = useFetcher<ActionData>();
  const pendingActionRef = useRef<PendingAction | null>(null);
  const isEdit = mode === "edit";
  const isLockedCategory = Boolean(lockedCategory);
  const navigate = useNavigate();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const returnPath = lockedCategory?.returnPath ?? config.listPath;

  useEffect(() => {
    if (!pendingActionRef.current) {
      return;
    }

    const pending = pendingActionRef.current;
    if (!pending.started) {
      if (actionFetcher.state === "idle") {
        return;
      }
      pending.started = true;
      return;
    }

    if (actionFetcher.state !== "idle") {
      return;
    }

    pendingActionRef.current = null;

    const data = actionFetcher.data;
    if (!data) {
      pending.reject({ message: "요청 응답이 비어 있습니다." });
      return;
    }

    if (!data.ok) {
      pending.reject({
        message: data.message ?? "요청 처리에 실패했습니다.",
        fieldErrors: data.fieldErrors,
      });
      return;
    }

    pending.resolve(data);
  }, [actionFetcher.data, actionFetcher.state]);

  useEffect(() => {
    return () => {
      if (pendingActionRef.current) {
        pendingActionRef.current.reject({ message: "요청이 취소되었습니다." });
        pendingActionRef.current = null;
      }
    };
  }, []);

  const postEditorAction = useCallback(
    (formData: FormData) => {
      if (pendingActionRef.current) {
        return Promise.reject({ message: "이전 요청이 아직 처리 중입니다." });
      }

      return new Promise<ActionData>((resolve, reject) => {
        pendingActionRef.current = { resolve, reject, started: false };
        actionFetcher.submit(formData, {
          method: "post",
          encType: "multipart/form-data",
        });
      });
    },
    [actionFetcher]
  );

  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [categoryList, setCategoryList] = useState<CategoryItem[]>(categories);
  const [selectedCategoryId, setSelectedCategoryId] = useState(
    lockedCategory?.id ?? item?.categoryIds?.[0] ?? ""
  );
  const [mainFile, setMainFile] = useState<File | null>(null);
  const [thumbFile, setThumbFile] = useState<File | null>(null);
  const [mainProgress, setMainProgress] = useState<number | null>(null);
  const [thumbProgress, setThumbProgress] = useState<number | null>(null);
  const [mainMeta, setMainMeta] = useState(item?.file ?? null);
  const [thumbMeta, setThumbMeta] = useState(item?.thumbnail ?? null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: "success" | "critical"; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingMain, setUploadingMain] = useState(false);
  const [uploadingThumb, setUploadingThumb] = useState(false);

  const [depth1Name, setDepth1Name] = useState("");
  const [depth1Slug, setDepth1Slug] = useState("");
  const [depth2Name, setDepth2Name] = useState("");
  const [depth2Slug, setDepth2Slug] = useState("");
  const [depth2ParentId, setDepth2ParentId] = useState("");
  const [depth3Name, setDepth3Name] = useState("");
  const [depth3Slug, setDepth3Slug] = useState("");
  const [depth3ParentId, setDepth3ParentId] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState("");
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editSortOrder, setEditSortOrder] = useState("0");
  const [editIsActive, setEditIsActive] = useState(true);

  useEffect(() => {
    setCategoryList(categories);
  }, [categories]);

  useEffect(() => {
    if (lockedCategory?.id) {
      setSelectedCategoryId(lockedCategory.id);
    }
  }, [lockedCategory?.id]);

  const categoryTree = useMemo(() => buildCategoryTree(categoryList), [categoryList]);
  const categoryById = useMemo(
    () => new Map(categoryList.map((category) => [category.id, category])),
    [categoryList]
  );

  const toCategoryPath = useCallback((categoryId: string) => {
    const names: string[] = [];
    const visited = new Set<string>();
    let cursorId: string | null = categoryId;

    while (cursorId) {
      if (visited.has(cursorId)) break;
      visited.add(cursorId);
      const current = categoryById.get(cursorId);
      if (!current) break;
      names.push(current.name);
      cursorId = current.parentId;
    }

    return names.reverse().join(" / ");
  }, [categoryById]);

  const depth1Options = useMemo(
    () =>
      [{ label: "Select Depth1", value: "" }].concat(
        categoryList
          .filter((category) => category.depth === 1)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
          .map((category) => ({
            label: `${category.name}${category.isActive ? "" : " (inactive)"}`,
            value: category.id,
          }))
      ),
    [categoryList]
  );

  const depth2Options = useMemo(
    () =>
      [{ label: "Select Depth2", value: "" }].concat(
        categoryList
          .filter((category) => category.depth === 2)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
          .map((category) => ({
            label: `${toCategoryPath(category.id)}${category.isActive ? "" : " (inactive)"}`,
            value: category.id,
          }))
      ),
    [categoryList, toCategoryPath]
  );

  async function handleUpload(kind: "main" | "thumbnail") {
    const file = kind === "main" ? mainFile : thumbFile;
    if (!file) {
      setBanner({ tone: "critical", message: "업로드할 파일을 선택해 주세요." });
      return;
    }

    const uploadKind = kind === "main" ? config.mainUploadKind : "THUMBNAIL";
    const setUploading = kind === "main" ? setUploadingMain : setUploadingThumb;
    const setProgress = kind === "main" ? setMainProgress : setThumbProgress;

    try {
      setUploading(true);
      setProgress(0);
      setBanner(null);

      if (kind === "main" && config.domain === "video") {
        const startFd = new FormData();
        startFd.set("intent", "prepare-multipart-upload");
        startFd.set("fileName", file.name);
        startFd.set("mimeType", file.type || config.mainMimeType);
        startFd.set("fileSizeBytes", String(file.size));

        const prepared = await postEditorAction(startFd);
        if (!prepared.multipartUpload) {
          throw { message: "multipart upload 시작 응답이 올바르지 않습니다." };
        }

        const session = prepared.multipartUpload;
        const uploadedParts: Array<{ partNumber: number; eTag: string }> = [];
        const uploadedBytesByPart = new Map<number, number>();
        const updateProgress = (partNumber: number, loadedBytes: number) => {
          uploadedBytesByPart.set(partNumber, Math.min(loadedBytes, file.size));
          const totalUploadedBytes = Array.from(uploadedBytesByPart.values()).reduce(
            (sum, bytes) => sum + bytes,
            0
          );
          setProgress(Math.max(0, Math.min(100, Math.floor((totalUploadedBytes / file.size) * 100))));
        };

        try {
          for (
            let firstPartNumber = 1;
            firstPartNumber <= session.partCount;
            firstPartNumber += MULTIPART_SIGN_BATCH_SIZE
          ) {
            const partNumbers = Array.from(
              {
                length: Math.min(
                  MULTIPART_SIGN_BATCH_SIZE,
                  session.partCount - firstPartNumber + 1
                ),
              },
              (_, index) => firstPartNumber + index
            );
            const signFd = new FormData();
            signFd.set("intent", "sign-multipart-parts");
            signFd.set("uploadToken", session.uploadToken);
            signFd.set("partNumbers", JSON.stringify(partNumbers));
            const signed = await postEditorAction(signFd);
            const signedByPartNumber = new Map(
              (signed.multipartPartUrls ?? []).map((part) => [part.partNumber, part.uploadUrl])
            );

            if (signedByPartNumber.size !== partNumbers.length) {
              throw new Error("multipart part URL 응답이 올바르지 않습니다.");
            }

            for (let offset = 0; offset < partNumbers.length; offset += MULTIPART_UPLOAD_CONCURRENCY) {
              const concurrentPartNumbers = partNumbers.slice(
                offset,
                offset + MULTIPART_UPLOAD_CONCURRENCY
              );
              const completed = await Promise.all(
                concurrentPartNumbers.map(async (partNumber) => {
                  const uploadUrl = signedByPartNumber.get(partNumber);
                  if (!uploadUrl) throw new Error("multipart part URL이 없습니다.");
                  const start = (partNumber - 1) * session.partSizeBytes;
                  const part = file.slice(start, Math.min(start + session.partSizeBytes, file.size));
                  const eTag = await uploadMultipartPartWithRetry(uploadUrl, part, (loadedBytes) =>
                    updateProgress(partNumber, loadedBytes)
                  );
                  return { partNumber, eTag };
                })
              );
              uploadedParts.push(...completed);
            }
          }

          const completeFd = new FormData();
          completeFd.set("intent", "complete-multipart-upload");
          completeFd.set("uploadToken", session.uploadToken);
          completeFd.set("parts", JSON.stringify(uploadedParts));
          const completed = await postEditorAction(completeFd);
          if (!completed.multipartCompleted) {
            throw new Error("multipart upload 완료 응답이 올바르지 않습니다.");
          }

          setProgress(100);
          setMainMeta({
            assetId: session.assetId,
            s3Bucket: session.s3Bucket,
            s3Key: session.s3Key,
            mimeType: file.type || config.mainMimeType,
            sizeBytes: completed.multipartCompleted.sizeBytes,
            status: "READY",
          });
          setBanner({ tone: "success", message: "영상 multipart 업로드 완료" });
          return;
        } catch (error) {
          const abortFd = new FormData();
          abortFd.set("intent", "abort-multipart-upload");
          abortFd.set("uploadToken", session.uploadToken);
          try {
            await postEditorAction(abortFd);
          } catch {
            // Lifecycle rule removes a remaining incomplete upload after its retention period.
          }
          throw error;
        }
      }

      const fd = new FormData();
      fd.set("intent", "prepare-upload");
      fd.set("kind", uploadKind);
      fd.set("fileName", file.name);
      fd.set("mimeType", file.type || "application/octet-stream");

      const prepared = await postEditorAction(fd);
      if (!prepared.upload) {
        throw { message: "업로드 URL 응답이 올바르지 않습니다." };
      }

      const isPlaceholderUpload =
        prepared.upload.mode === "placeholder" ||
        prepared.upload.uploadUrl.includes("/upload-placeholder/");
      const canFallbackViaServer =
        !isPlaceholderUpload &&
        Boolean(prepared.upload.s3Bucket) &&
        Boolean(prepared.upload.s3Key);
      let usedServerFallback = false;
      if (isPlaceholderUpload) {
        setProgress(100);
      } else {
        try {
          await uploadFile(prepared.upload.uploadUrl, file, setProgress);
        } catch (uploadError) {
          if (!canFallbackViaServer) {
            throw uploadError;
          }
          await uploadFileViaServer(
            postEditorAction,
            {
              s3Bucket: prepared.upload.s3Bucket,
              s3Key: prepared.upload.s3Key,
            },
            file,
            file.type || "application/octet-stream",
            uploadKind,
            setProgress
          );
          usedServerFallback = true;
        }
      }

      if (kind === "main") {
        setMainMeta({
          assetId: prepared.upload.assetId,
          s3Bucket: prepared.upload.s3Bucket,
          s3Key: prepared.upload.s3Key,
          mimeType: file.type || config.mainMimeType,
          sizeBytes: file.size,
          status: "READY",
        });
      } else {
        setThumbMeta({
          s3Bucket: prepared.upload.s3Bucket,
          s3Key: prepared.upload.s3Key,
          mimeType: file.type || "image/jpeg",
          sizeBytes: file.size,
          status: "READY",
        });
      }

      setBanner({
        tone: "success",
        message: usedServerFallback
          ? "브라우저 직접 업로드가 실패해 서버 경유 업로드로 전환했습니다."
          : `${kind === "main" ? config.label : "썸네일"} 업로드 완료`,
      });
    } catch (error) {
      const normalized = normalizeFieldError(error);
      setBanner({ tone: "critical", message: normalized.message });
    } finally {
      setUploading(false);
    }
  }

  async function handleCreateCategory(depth: 1 | 2 | 3) {
    const name =
      depth === 1 ? depth1Name.trim() : depth === 2 ? depth2Name.trim() : depth3Name.trim();
    const slug =
      depth === 1 ? depth1Slug.trim() : depth === 2 ? depth2Slug.trim() : depth3Slug.trim();
    const parentId = depth === 1 ? null : depth === 2 ? depth2ParentId : depth3ParentId;

    if (!name) {
      setBanner({ tone: "critical", message: "카테고리 이름을 입력해 주세요." });
      return;
    }

    if (depth === 2 && !depth2ParentId) {
      setBanner({ tone: "critical", message: "Depth2 생성 전에 상위 Depth1 카테고리를 선택해 주세요." });
      return;
    }

    if (depth === 3 && !depth3ParentId) {
      setBanner({ tone: "critical", message: "Depth3 생성 전에 상위 Depth2 카테고리를 선택해 주세요." });
      return;
    }

    try {
      setCategoryBusy(true);
      const fd = new FormData();
      fd.set("intent", "create-category");
      fd.set("name", name);
      fd.set("slug", slug || slugifyCategory(name));
      fd.set("depth", String(depth));
      fd.set("parentId", parentId ?? "");
      const siblingSortOrder = categoryList
        .filter((category) => category.depth === depth && category.parentId === parentId)
        .reduce((max, category) => Math.max(max, category.sortOrder), -10);
      const nextSortOrder = siblingSortOrder + 10;
      fd.set("sortOrder", String(nextSortOrder));
      fd.set("isActive", "true");

      const created = await postEditorAction(fd);
      if (created.id) {
        const nextCategory: CategoryItem = {
          id: created.id as string,
          name,
          slug: slug || slugifyCategory(name),
          depth,
          parentId,
          sortOrder: nextSortOrder,
          isActive: true,
        };
        setCategoryList((prev) =>
          upsertCategoryById(prev, nextCategory)
        );
      }
      setBanner({ tone: "success", message: created.message ?? "카테고리를 생성했습니다." });
      if (depth === 1) {
        setDepth1Name("");
        setDepth1Slug("");
      } else if (depth === 2) {
        setDepth2Name("");
        setDepth2Slug("");
      } else {
        setDepth3Name("");
        setDepth3Slug("");
      }
    } catch (error) {
      const normalized = normalizeFieldError(error);
      setBanner({ tone: "critical", message: normalized.message });
    } finally {
      setCategoryBusy(false);
    }
  }

  function startCategoryEdit(category: CategoryItem) {
    setEditingCategoryId(category.id);
    setEditName(category.name);
    setEditSlug(category.slug);
    setEditSortOrder(String(category.sortOrder));
    setEditIsActive(category.isActive);
  }

  function cancelCategoryEdit() {
    setEditingCategoryId("");
    setEditName("");
    setEditSlug("");
    setEditSortOrder("0");
    setEditIsActive(true);
  }

  async function handleSaveCategoryEdit() {
    if (!editingCategoryId) return;
    const name = editName.trim();
    if (!name) {
      setBanner({ tone: "critical", message: "카테고리 이름을 입력해 주세요." });
      return;
    }

    const nextSortOrder = Number(editSortOrder || "0");
    if (!Number.isInteger(nextSortOrder) || nextSortOrder < 0) {
      setBanner({ tone: "critical", message: "정렬값은 0 이상의 정수여야 합니다." });
      return;
    }

    try {
      setCategoryBusy(true);
      const fd = new FormData();
      fd.set("intent", "update-category");
      fd.set("categoryId", editingCategoryId);
      fd.set("name", name);
      fd.set("slug", editSlug.trim() || slugifyCategory(name));
      fd.set("sortOrder", String(nextSortOrder));
      fd.set("isActive", String(editIsActive));

      const updated = await postEditorAction(fd);
      setCategoryList((prev) =>
        prev.map((category) =>
          category.id === editingCategoryId
            ? {
                ...category,
                name,
                slug: editSlug.trim() || slugifyCategory(name),
                sortOrder: nextSortOrder,
                isActive: editIsActive,
              }
            : category
        )
      );
      cancelCategoryEdit();
      setBanner({ tone: "success", message: updated.message ?? "카테고리를 수정했습니다." });
    } catch (error) {
      const normalized = normalizeFieldError(error);
      setBanner({ tone: "critical", message: normalized.message });
    } finally {
      setCategoryBusy(false);
    }
  }

  async function handleDeleteCategory(category: CategoryItem) {
    if (!window.confirm(`"${category.name}" 카테고리와 하위 카테고리를 삭제하시겠습니까?`)) return;

    try {
      setCategoryBusy(true);
      const fd = new FormData();
      fd.set("intent", "delete-category");
      fd.set("categoryId", category.id);
      const deleted = await postEditorAction(fd);

      const deletedIds = collectDescendantCategoryIds(categoryList, category.id);
      setCategoryList((prev) => prev.filter((item) => !deletedIds.includes(item.id)));
      if (deletedIds.includes(selectedCategoryId)) {
        setSelectedCategoryId("");
      }
      if (deletedIds.includes(editingCategoryId)) {
        cancelCategoryEdit();
      }

      setBanner({ tone: "success", message: deleted.message ?? "카테고리를 삭제했습니다." });
    } catch (error) {
      const normalized = normalizeFieldError(error);
      setBanner({ tone: "critical", message: normalized.message });
    } finally {
      setCategoryBusy(false);
    }
  }

  async function handleMoveCategory(category: CategoryItem, direction: "up" | "down") {
    const siblings = categoryList
      .filter(
        (item) =>
          item.depth === category.depth &&
          (item.parentId ?? null) === (category.parentId ?? null)
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    const index = siblings.findIndex((item) => item.id === category.id);
    if (index < 0) return;
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) return;

    const next = siblings.slice();
    const [current] = next.splice(index, 1);
    next.splice(swapIndex, 0, current);

    const desiredOrders = next.map((item, idx) => ({ id: item.id, sortOrder: idx * 10 }));
    const changed = desiredOrders.filter(({ id, sortOrder }) => {
      const original = siblings.find((item) => item.id === id);
      return (original?.sortOrder ?? 0) !== sortOrder;
    });

    if (changed.length === 0) return;

    try {
      setCategoryBusy(true);
      for (const change of changed) {
        const fd = new FormData();
        fd.set("intent", "update-category");
        fd.set("categoryId", change.id);
        fd.set("sortOrder", String(change.sortOrder));
        await postEditorAction(fd);
      }

      setCategoryList((prev) =>
        prev.map((item) => {
          const changedItem = changed.find((change) => change.id === item.id);
          return changedItem ? { ...item, sortOrder: changedItem.sortOrder } : item;
        })
      );

      if (editingCategoryId) {
        const editingChange = changed.find((item) => item.id === editingCategoryId);
        if (editingChange) {
          setEditSortOrder(String(editingChange.sortOrder));
        }
      }

      setBanner({ tone: "success", message: "카테고리 정렬을 변경했습니다." });
    } catch (error) {
      const normalized = normalizeFieldError(error);
      setBanner({ tone: "critical", message: normalized.message });
    } finally {
      setCategoryBusy(false);
    }
  }

  async function handleSave() {
    const nextFieldErrors: Record<string, string> = {};

    if (!title.trim()) nextFieldErrors.title = "제목은 필수입니다.";
    if (!selectedCategoryId) nextFieldErrors.categoryIds = "카테고리를 선택해 주세요.";
    if (!mainMeta || mainMeta.status !== "READY") {
      nextFieldErrors["file.assetId"] = `${config.label} 파일 업로드를 완료해 주세요.`;
    }

    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) {
      setBanner({ tone: "critical", message: "필수 항목을 확인해 주세요." });
      return;
    }

    try {
      setSaving(true);
      const fd = new FormData();
      fd.set("intent", "save");
      fd.set(
        "payload",
        JSON.stringify({
          ...(item?.id ? { id: item.id } : {}),
          title: title.trim(),
          categoryIds: [selectedCategoryId],
          file: mainMeta,
          ...(thumbMeta
            ? {
                thumbnail: {
                  assetId: (thumbMeta as { assetId?: string }).assetId,
                  s3Bucket: thumbMeta.s3Bucket,
                  s3Key: thumbMeta.s3Key,
                  mimeType: thumbMeta.mimeType,
                  sizeBytes: thumbMeta.sizeBytes,
                  status: "READY",
                },
              }
            : {}),
          isActive,
          description: description.trim() || undefined,
        })
      );

      const result = await postEditorAction(fd);
      setFieldErrors({});
      setBanner({ tone: "success", message: result.message ?? "저장을 완료했습니다." });

      if (!isEdit && result.id) {
        navigate(
          toInApp(
            isLockedCategory ? returnPath : `${config.listPath}/${encodeURIComponent(result.id)}`
          )
        );
      }
    } catch (error) {
      const normalized = normalizeFieldError(error);
      setFieldErrors(normalized.fieldErrors ?? {});
      setBanner({ tone: "critical", message: normalized.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    if (!window.confirm("정말 삭제하시겠습니까?")) return;

    try {
      const fd = new FormData();
      fd.set("intent", "delete-asset");
      await postEditorAction(fd);
      navigate(toInApp(returnPath));
    } catch (error) {
      const normalized = normalizeFieldError(error);
      setBanner({ tone: "critical", message: normalized.message });
    }
  }

  function renderCategoryNodes(nodes: CategoryTreeNode[], level = 0) {
    return (
      <List>
        {nodes.map((node, index) => (
          <List.Item key={node.id}>
            <BlockStack gap="150">
              <InlineStack align="space-between" blockAlign="center">
                <Checkbox
                  label={`${level > 0 ? "— ".repeat(level) : ""}${node.name}${node.isActive ? "" : " (inactive)"}`}
                  checked={selectedCategoryId === node.id}
                  onChange={(checked) => setSelectedCategoryId(checked ? node.id : "")}
                  disabled={categoryBusy}
                />
                <InlineStack gap="100">
                  <Button
                    size="micro"
                    onClick={() => handleMoveCategory(node, "up")}
                    disabled={categoryBusy || index === 0}
                  >
                    Up
                  </Button>
                  <Button
                    size="micro"
                    onClick={() => handleMoveCategory(node, "down")}
                    disabled={categoryBusy || index === nodes.length - 1}
                  >
                    Down
                  </Button>
                  <Button
                    size="micro"
                    onClick={() => startCategoryEdit(node)}
                    disabled={categoryBusy}
                  >
                    Edit
                  </Button>
                  <Button
                    size="micro"
                    tone="critical"
                    onClick={() => handleDeleteCategory(node)}
                    disabled={categoryBusy}
                  >
                    Delete
                  </Button>
                </InlineStack>
              </InlineStack>

              <Text as="p" variant="bodySm" tone="subdued">
                slug: {node.slug} / sort: {node.sortOrder}
              </Text>

              {editingCategoryId === node.id ? (
                <Card>
                  <BlockStack gap="200">
                    <TextField
                      label="Name"
                      autoComplete="off"
                      value={editName}
                      onChange={setEditName}
                      disabled={categoryBusy}
                    />
                    <TextField
                      label="Slug"
                      autoComplete="off"
                      value={editSlug}
                      onChange={setEditSlug}
                      disabled={categoryBusy}
                    />
                    <TextField
                      label="Sort Order"
                      autoComplete="off"
                      type="number"
                      value={editSortOrder}
                      onChange={setEditSortOrder}
                      disabled={categoryBusy}
                    />
                    <Checkbox
                      label="Active"
                      checked={editIsActive}
                      onChange={setEditIsActive}
                      disabled={categoryBusy}
                    />
                    <InlineStack gap="200">
                      <Button
                        variant="primary"
                        onClick={handleSaveCategoryEdit}
                        disabled={categoryBusy}
                        loading={categoryBusy}
                      >
                        Save Category
                      </Button>
                      <Button onClick={cancelCategoryEdit} disabled={categoryBusy}>
                        Cancel
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Card>
              ) : null}

            </BlockStack>
            {node.children.length > 0 ? (
              <Box paddingInlineStart="400">{renderCategoryNodes(node.children, level + 1)}</Box>
            ) : null}
          </List.Item>
        ))}
      </List>
    );
  }

  const saveDisabled = uploadingMain || uploadingThumb || saving || categoryBusy;

  return (
    <Page>
      <TitleBar
        title={
          isLockedCategory
            ? `GKV ${config.label} Upload`
            : `${config.label} ${isEdit ? "Edit" : "New"}`
        }
      />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            {isLockedCategory
              ? `GKV ${config.label} Upload`
              : `${config.label} ${isEdit ? "Edit" : "Create"}`}
          </Text>
          <InlineStack gap="200">
            <Button onClick={() => navigate(toInApp(returnPath))}>
              {isLockedCategory ? "Back to GKV Guides" : "Back to List"}
            </Button>
            {isEdit ? (
              <Button tone="critical" onClick={handleDelete}>
                Delete
              </Button>
            ) : null}
          </InlineStack>
        </InlineStack>

        {banner ? (
          <Banner tone={banner.tone}>
            <p>{banner.message}</p>
          </Banner>
        ) : null}

        {error ? (
          <Banner tone="critical">
            <p>{error}</p>
          </Banner>
        ) : null}

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          {isLockedCategory && lockedCategory ? (
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Selected Category
                </Text>
                <BlockStack gap="100">
                  <Text as="p" variant="bodyMd">
                    {lockedCategory.path}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued" breakWord>
                    categoryId: {lockedCategory.id}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    이 화면에서는 카테고리를 변경하지 않습니다. 다른 카테고리에 추가하려면 GKV Guides에서 해당 행의 업로드 버튼을 사용하세요.
                  </Text>
                </BlockStack>
                <Divider />
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Asset Type
                  </Text>
                  <InlineStack gap="200">
                    <Button
                      variant={config.domain === "pdf" ? "primary" : "secondary"}
                      onClick={() =>
                        navigate(
                          toInApp(
                            `/app/gkv/guides/${encodeURIComponent(lockedCategory.id)}/assets/new?kind=pdf`
                          )
                        )
                      }
                    >
                      PDF
                    </Button>
                    <Button
                      variant={config.domain === "video" ? "primary" : "secondary"}
                      onClick={() =>
                        navigate(
                          toInApp(
                            `/app/gkv/guides/${encodeURIComponent(lockedCategory.id)}/assets/new?kind=video`
                          )
                        )
                      }
                    >
                      VIDEO
                    </Button>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          ) : (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Categories
              </Text>
              {fieldErrors.categoryIds ? (
                <Text as="p" variant="bodySm" tone="critical">
                  {fieldErrors.categoryIds}
                </Text>
              ) : null}

              {categoryTree.length === 0 ? (
                <Text as="p" variant="bodyMd" tone="subdued">
                  카테고리가 없습니다.
                </Text>
              ) : (
                renderCategoryNodes(categoryTree)
              )}

              <Divider />
              <Text as="h3" variant="headingSm">
                Add Depth1
              </Text>
              <TextField
                label="Name"
                autoComplete="off"
                value={depth1Name}
                onChange={setDepth1Name}
                disabled={categoryBusy}
              />
              <TextField
                label="Slug"
                autoComplete="off"
                value={depth1Slug}
                onChange={setDepth1Slug}
                disabled={categoryBusy}
              />
              <Button onClick={() => handleCreateCategory(1)} loading={categoryBusy} disabled={categoryBusy}>
                Add Depth1
              </Button>

              <Divider />
              <Text as="h3" variant="headingSm">
                Add Depth2
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                선택한 Depth1 하위에 생성됩니다.
              </Text>
              <Select
                label="Parent Depth1"
                options={depth1Options}
                value={depth2ParentId}
                onChange={setDepth2ParentId}
                disabled={categoryBusy}
              />
              <TextField
                label="Name"
                autoComplete="off"
                value={depth2Name}
                onChange={setDepth2Name}
                disabled={categoryBusy}
              />
              <TextField
                label="Slug"
                autoComplete="off"
                value={depth2Slug}
                onChange={setDepth2Slug}
                disabled={categoryBusy}
              />
              <Button onClick={() => handleCreateCategory(2)} loading={categoryBusy} disabled={categoryBusy}>
                Add Depth2
              </Button>

              <Divider />
              <Text as="h3" variant="headingSm">
                Add Depth3
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                선택한 Depth2 하위에 생성됩니다.
              </Text>
              <Select
                label="Parent Depth2"
                options={depth2Options}
                value={depth3ParentId}
                onChange={setDepth3ParentId}
                disabled={categoryBusy}
              />
              <TextField
                label="Name"
                autoComplete="off"
                value={depth3Name}
                onChange={setDepth3Name}
                disabled={categoryBusy}
              />
              <TextField
                label="Slug"
                autoComplete="off"
                value={depth3Slug}
                onChange={setDepth3Slug}
                disabled={categoryBusy}
              />
              <Button onClick={() => handleCreateCategory(3)} loading={categoryBusy} disabled={categoryBusy}>
                Add Depth3
              </Button>
            </BlockStack>
          </Card>
          )}

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {config.label} Form
              </Text>

              <TextField
                label="Title"
                autoComplete="off"
                value={title}
                onChange={setTitle}
                error={fieldErrors.title}
              />

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  File Upload ({config.label})
                </Text>
                <input
                  type="file"
                  accept={config.accept}
                  onChange={(event) => setMainFile(event.target.files?.[0] ?? null)}
                />
                {config.domain === "video" ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    영상은 서버를 경유하지 않고 S3 multipart 방식으로 업로드됩니다. 앱의 파일 용량 제한은 없으며 S3 객체 한도는 5TiB입니다.
                  </Text>
                ) : null}
                <InlineStack>
                  <Button
                    onClick={() => handleUpload("main")}
                    loading={uploadingMain}
                    disabled={!mainFile || uploadingMain || uploadingThumb}
                  >
                    Upload {config.label}
                  </Button>
                </InlineStack>
                {mainProgress !== null ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Progress: {mainProgress}%
                  </Text>
                ) : null}
                {mainMeta ? (
                  <Text as="p" variant="bodySm" tone="subdued" breakWord>
                    {mainMeta.s3Key}
                  </Text>
                ) : null}
                {fieldErrors["file.assetId"] ? (
                  <Text as="p" variant="bodySm" tone="critical">
                    {fieldErrors["file.assetId"]}
                  </Text>
                ) : null}
              </BlockStack>

              <Divider />
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Thumbnail Upload (optional)
                </Text>
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  onChange={(event) => setThumbFile(event.target.files?.[0] ?? null)}
                />
                <InlineStack>
                  <Button
                    onClick={() => handleUpload("thumbnail")}
                    loading={uploadingThumb}
                    disabled={!thumbFile || uploadingMain || uploadingThumb}
                  >
                    Upload Thumbnail
                  </Button>
                </InlineStack>
                {thumbProgress !== null ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Progress: {thumbProgress}%
                  </Text>
                ) : null}
                {thumbMeta?.s3Key ? (
                  <Text as="p" variant="bodySm" tone="subdued" breakWord>
                    {thumbMeta.s3Key}
                  </Text>
                ) : null}
              </BlockStack>

              <TextField
                label="Description"
                autoComplete="off"
                multiline={4}
                value={description}
                onChange={setDescription}
              />

              <Checkbox
                label="Active"
                checked={isActive}
                onChange={setIsActive}
              />

              <InlineStack>
                <Button variant="primary" onClick={handleSave} loading={saving} disabled={saveDisabled}>
                  Save
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
