import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Link, useFetcher, useLoaderData, useLocation, useRevalidator } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";
import { withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";

type AssetItem = {
  id: string;
  kind: "PDF" | "VIDEO";
  title: string;
  s3Bucket: string;
  s3Key: string;
  mimeType: string;
  sizeBytes: number | null;
  checksumSha256: string | null;
  durationSec: number | null;
  status: "UPLOADING" | "READY" | "FAILED";
  createdAt: string;
  updatedAt: string;
  categoryIds?: string[];
  categoryPaths?: string[];
  usageCategoryCount?: number;
  currentCategoryIds?: string[];
  currentCategoryPaths?: string[];
};

type LoaderData = {
  items: AssetItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
  upload?: {
    assetId: string;
    uploadUrl: string;
    s3Bucket: string;
    s3Key: string;
  };
};

function parseIntSafe(value: FormDataEntryValue | null): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readVideoDurationSec(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const sec =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.ceil(video.duration)
          : undefined;
      URL.revokeObjectURL(url);
      resolve(sec);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
    video.src = url;
  });
}

async function postAssetAction(formData: FormData): Promise<ActionData> {
  const res = await fetch(window.location.pathname, {
    method: "POST",
    body: formData,
    headers: { Accept: "application/json" },
  });
  const data = (await res.json()) as ActionData;
  if (!res.ok || !data.ok) {
    throw new Error(data.message || `요청 실패 (${res.status})`);
  }
  return data;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const data = await callGkvAdminApi<{ items: AssetItem[] }>(request, "/admin/gkv/assets");
    return json<LoaderData>({ items: data.items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "에셋을 불러오지 못했습니다.";
    return json<LoaderData>({ items: [], error: message });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const id = String(formData.get("id") || "");

    if (intent === "prepare-upload") {
      const kind = String(formData.get("kind") || "PDF");
      const fileName = String(formData.get("fileName") || "");
      const mimeType = String(formData.get("mimeType") || "");
      const upload = await callGkvAdminApi<{
        assetId: string;
        uploadUrl: string;
        s3Bucket: string;
        s3Key: string;
      }>(request, "/admin/gkv/assets/upload-url", {
        method: "POST",
        body: JSON.stringify({ kind, fileName, mimeType }),
      });
      return json<ActionData>({
        ok: true,
        message: "업로드 URL을 발급했습니다.",
        upload,
      });
    }

    if (intent === "register-uploaded") {
      const sizeBytes = parseIntSafe(formData.get("sizeBytes"));
      const durationSec = parseIntSafe(formData.get("durationSec"));
      await callGkvAdminApi<{ id: string }>(request, "/admin/gkv/assets", {
        method: "POST",
        body: JSON.stringify({
          id: String(formData.get("assetId") || ""),
          kind: String(formData.get("kind") || "PDF"),
          title: String(formData.get("title") || ""),
          s3Bucket: String(formData.get("s3Bucket") || ""),
          s3Key: String(formData.get("s3Key") || ""),
          mimeType: String(formData.get("mimeType") || ""),
          status: "READY",
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(durationSec !== undefined ? { durationSec } : {}),
        }),
      });
      return json<ActionData>({ ok: true, message: "파일 업로드 후 에셋 등록을 완료했습니다." });
    }

    if (intent === "create") {
      const sizeBytes = parseIntSafe(formData.get("sizeBytes"));
      const durationSec = parseIntSafe(formData.get("durationSec"));
      await callGkvAdminApi<{ id: string }>(request, "/admin/gkv/assets", {
        method: "POST",
        body: JSON.stringify({
          kind: String(formData.get("kind") || "PDF"),
          title: String(formData.get("title") || ""),
          s3Bucket: String(formData.get("s3Bucket") || ""),
          s3Key: String(formData.get("s3Key") || ""),
          mimeType: String(formData.get("mimeType") || ""),
          status: String(formData.get("status") || "READY"),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(durationSec !== undefined ? { durationSec } : {}),
          checksumSha256: String(formData.get("checksumSha256") || ""),
        }),
      });
      return json<ActionData>({ ok: true, message: "에셋을 생성했습니다." });
    }

    if (!id) {
      return json<ActionData>({ ok: false, message: "id가 필요합니다." }, { status: 400 });
    }

    if (intent === "delete") {
      await callGkvAdminApi<{ id: string; deleted: boolean }>(request, `/admin/gkv/assets/${id}`, {
        method: "DELETE",
      });
      return json<ActionData>({ ok: true, message: "에셋을 삭제했습니다." });
    }

    if (intent === "set-status") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(request, `/admin/gkv/assets/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          status: String(formData.get("status") || "READY"),
        }),
      });
      return json<ActionData>({ ok: true, message: "상태를 변경했습니다." });
    }

    return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }
    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

export default function GkvAssetsPage() {
  const { items, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const uploadFetcher = useFetcher<ActionData>();
  const registerFetcher = useFetcher<ActionData>();
  const revalidator = useRevalidator();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const [uploadKind, setUploadKind] = useState<"PDF" | "VIDEO">("PDF");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadDurationSec, setUploadDurationSec] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preparedUpload, setPreparedUpload] = useState<ActionData["upload"] | null>(null);
  const [fileInputResetKey, setFileInputResetKey] = useState(0);
  const [uploadState, setUploadState] = useState<
    "idle" | "preparing" | "uploading" | "registering" | "done" | "failed" | "cancelled"
  >("idle");
  const [uploadMessage, setUploadMessage] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [searchValue, setSearchValue] = useState("");
  const [kindFilter, setKindFilter] = useState("ALL");
  const [usageFilter, setUsageFilter] = useState("ALL");
  const uploadXhrRef = useRef<XMLHttpRequest | null>(null);

  const filteredItems = useMemo(() => {
    const q = searchValue.trim().toLowerCase();
    return items.filter((item) => {
      if (kindFilter !== "ALL" && item.kind !== kindFilter) {
        return false;
      }
      const usageCount = item.usageCategoryCount ?? 0;
      const currentCount = item.currentCategoryIds?.length ?? 0;
      if (usageFilter === "UNASSIGNED" && usageCount !== 0) {
        return false;
      }
      if (usageFilter === "CURRENT" && currentCount === 0) {
        return false;
      }
      if (usageFilter === "SHARED" && usageCount <= 1) {
        return false;
      }
      if (!q) {
        return true;
      }
      return [item.title, item.id, item.s3Key, ...(item.categoryPaths ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [items, kindFilter, searchValue, usageFilter]);

  const rows = filteredItems.map((item) => [
    item.title,
    item.kind,
    item.mimeType,
    item.status === "READY" ? (
      <Badge tone="success">{item.status}</Badge>
    ) : item.status === "FAILED" ? (
      <Badge tone="critical">{item.status}</Badge>
    ) : (
      <Badge tone="attention">{item.status}</Badge>
    ),
    item.categoryPaths && item.categoryPaths.length > 0 ? (
      <BlockStack key={`${item.id}-categories`} gap="050">
        {item.categoryPaths.map((path, index) => {
          const categoryId = item.categoryIds?.[index];
          return categoryId ? (
            <Link
              key={`${item.id}-${categoryId}`}
              to={toInApp(`/app/gkv/guides/${encodeURIComponent(categoryId)}/assets`)}
            >
              {path}
            </Link>
          ) : (
            <Text key={`${item.id}-${path}`} as="span" variant="bodySm">
              {path}
            </Text>
          );
        })}
      </BlockStack>
    ) : (
      <Badge tone="attention">미연결</Badge>
    ),
    item.currentCategoryPaths && item.currentCategoryPaths.length > 0 ? (
      <BlockStack key={`${item.id}-current`} gap="050">
        <Badge tone="success">Current</Badge>
        {item.currentCategoryPaths.map((path) => (
          <Text key={`${item.id}-current-${path}`} as="span" variant="bodySm" tone="subdued">
            {path}
          </Text>
        ))}
      </BlockStack>
    ) : item.usageCategoryCount && item.usageCategoryCount > 1 ? (
      <Badge tone="info">공유됨</Badge>
    ) : item.usageCategoryCount === 1 ? (
      <Badge>Attached</Badge>
    ) : (
      <Badge tone="attention">Unused</Badge>
    ),
    item.s3Key,
    <InlineStack key={item.id} gap="200">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="set-status" />
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="status" value="READY" />
        <Button submit size="micro">
          READY
        </Button>
      </fetcher.Form>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="set-status" />
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="status" value="FAILED" />
        <Button submit size="micro">
          FAILED
        </Button>
      </fetcher.Form>
      {(item.usageCategoryCount ?? 0) <= 1 ? (
        <fetcher.Form
          method="post"
          onSubmit={(event) => {
            if (!window.confirm("이 asset을 전체 삭제할까요? 연결된 카테고리에서도 제거됩니다.")) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={item.id} />
          <Button submit size="micro" tone="critical">
            삭제
          </Button>
        </fetcher.Form>
      ) : null}
    </InlineStack>,
  ]);

  const prepared = preparedUpload;

  useEffect(() => {
    if (uploadFetcher.data?.upload) {
      setPreparedUpload(uploadFetcher.data.upload);
      setUploadState("idle");
      setUploadMessage("업로드 URL 발급 완료. 업로드+등록 버튼을 눌러주세요.");
    }
  }, [uploadFetcher.data]);

  useEffect(() => {
    if (!registerFetcher.data) {
      return;
    }
    if (registerFetcher.data.ok) {
      setUploadState("done");
      setUploadMessage(registerFetcher.data.message || "에셋 등록을 완료했습니다.");
      setPreparedUpload(null);
      setSelectedFile(null);
      setUploadDurationSec("");
      setUploadTitle("");
      setFileInputResetKey((v) => v + 1);
      revalidator.revalidate();
      return;
    }
    setUploadState("failed");
    setUploadMessage(registerFetcher.data.message || "에셋 등록에 실패했습니다.");
  }, [registerFetcher.data, revalidator]);

  function resetUploadForm() {
    setPreparedUpload(null);
    setSelectedFile(null);
    setUploadDurationSec("");
    setUploadTitle("");
    setUploadProgress(null);
    setFileInputResetKey((v) => v + 1);
  }

  async function uploadFileToS3(uploadUrl: string, file: File): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      uploadXhrRef.current = xhr;
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          return;
        }
        const percent = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
        setUploadProgress(percent);
      };
      xhr.onload = () => {
        uploadXhrRef.current = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadProgress(100);
          resolve();
          return;
        }
        reject(new Error(`S3 업로드 실패 (${xhr.status})`));
      };
      xhr.onerror = () => {
        uploadXhrRef.current = null;
        reject(new Error("S3 업로드 중 네트워크 오류가 발생했습니다."));
      };
      xhr.onabort = () => {
        uploadXhrRef.current = null;
        reject(new Error("업로드가 취소되었습니다."));
      };
      xhr.send(file);
    });
  }

  async function runUploadAndRegister() {
    if (!selectedFile) {
      setUploadState("failed");
      setUploadMessage("파일을 선택해 주세요.");
      return;
    }
    if (!prepared) {
      setUploadState("failed");
      setUploadMessage("먼저 업로드 URL을 발급해 주세요.");
      return;
    }

    try {
      setUploadState("uploading");
      setUploadMessage("S3 업로드 중...");
      setUploadProgress(0);
      await uploadFileToS3(prepared.uploadUrl, selectedFile);

      setUploadState("registering");
      setUploadMessage("업로드 성공. 에셋 등록 중...");
      const fd = new FormData();
      fd.set("intent", "register-uploaded");
      fd.set("assetId", prepared.assetId);
      fd.set("kind", uploadKind);
      fd.set("title", uploadTitle || selectedFile.name);
      fd.set("s3Bucket", prepared.s3Bucket);
      fd.set("s3Key", prepared.s3Key);
      fd.set("mimeType", selectedFile.type || "application/octet-stream");
      fd.set("sizeBytes", String(selectedFile.size));
      if (uploadKind === "VIDEO" && uploadDurationSec.trim()) {
        fd.set("durationSec", uploadDurationSec.trim());
      }
      registerFetcher.submit(fd, { method: "post" });
      setUploadMessage("등록 요청 전송 완료. 결과를 기다리는 중...");
    } catch (error) {
      const message = error instanceof Error ? error.message : "업로드 처리에 실패했습니다.";
      if (message.includes("취소")) {
        setUploadState("cancelled");
        setUploadMessage(message);
      } else {
        setUploadState("failed");
        setUploadMessage(message);
      }
      setUploadProgress(null);
    }
  }

  async function runOneClickUpload() {
    if (!selectedFile) {
      setUploadState("failed");
      setUploadMessage("파일을 선택해 주세요.");
      return;
    }

    try {
      setUploadState("preparing");
      setUploadMessage("원클릭 업로드 준비 중...");
      setUploadProgress(null);

      const prepareFd = new FormData();
      prepareFd.set("intent", "prepare-upload");
      prepareFd.set("kind", uploadKind);
      prepareFd.set("fileName", selectedFile.name);
      prepareFd.set("mimeType", selectedFile.type || "application/octet-stream");
      const preparedResult = await postAssetAction(prepareFd);
      if (!preparedResult.upload) {
        throw new Error("업로드 URL 응답이 올바르지 않습니다.");
      }
      setPreparedUpload(preparedResult.upload);

      setUploadState("uploading");
      setUploadMessage("S3 업로드 중...");
      setUploadProgress(0);
      await uploadFileToS3(preparedResult.upload.uploadUrl, selectedFile);

      setUploadState("registering");
      setUploadMessage("업로드 성공. 에셋 등록 중...");
      const registerFd = new FormData();
      registerFd.set("intent", "register-uploaded");
      registerFd.set("assetId", preparedResult.upload.assetId);
      registerFd.set("kind", uploadKind);
      registerFd.set("title", uploadTitle || selectedFile.name);
      registerFd.set("s3Bucket", preparedResult.upload.s3Bucket);
      registerFd.set("s3Key", preparedResult.upload.s3Key);
      registerFd.set("mimeType", selectedFile.type || "application/octet-stream");
      registerFd.set("sizeBytes", String(selectedFile.size));
      if (uploadKind === "VIDEO" && uploadDurationSec.trim()) {
        registerFd.set("durationSec", uploadDurationSec.trim());
      }

      const registered = await postAssetAction(registerFd);
      setUploadState("done");
      setUploadMessage(registered.message || "원클릭 업로드 및 등록을 완료했습니다.");
      resetUploadForm();
      revalidator.revalidate();
    } catch (error) {
      const message = error instanceof Error ? error.message : "원클릭 업로드에 실패했습니다.";
      if (message.includes("취소")) {
        setUploadState("cancelled");
      } else {
        setUploadState("failed");
      }
      setUploadMessage(message);
      setUploadProgress(null);
    }
  }

  function cancelUpload() {
    if (uploadXhrRef.current) {
      uploadXhrRef.current.abort();
      return;
    }
    setUploadState("cancelled");
    setUploadMessage("진행 중인 업로드가 없습니다.");
  }

  return (
    <Page>
      <TitleBar title="GKV Assets" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              파일 직접 업로드 (S3)
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              권장: 원클릭 업로드 버튼으로 한 번에 처리하세요. (보조: 2단계 수동 업로드)
            </Text>
            <uploadFetcher.Form method="post">
              <BlockStack gap="200">
                <input type="hidden" name="intent" value="prepare-upload" />
                <Select
                  name="kind"
                  label="Kind"
                  options={[
                    { label: "PDF", value: "PDF" },
                    { label: "VIDEO", value: "VIDEO" },
                  ]}
                  value={uploadKind}
                  onChange={(value) => setUploadKind(value as "PDF" | "VIDEO")}
                />
                <TextField
                  name="title"
                  label="Title"
                  value={uploadTitle}
                  onChange={setUploadTitle}
                  autoComplete="off"
                  helpText="비워두면 파일명으로 등록됩니다."
                />
                <TextField
                  name="durationSec"
                  type="number"
                  label="Duration Sec (VIDEO 선택 시)"
                  value={uploadDurationSec}
                  onChange={setUploadDurationSec}
                  autoComplete="off"
                  helpText="VIDEO 파일 선택 시 메타데이터에서 자동 입력됩니다."
                />
                <div>
                  <Text as="p" variant="bodyMd">
                    파일 선택
                  </Text>
                  <input
                    key={fileInputResetKey}
                    type="file"
                    accept={uploadKind === "PDF" ? ".pdf,application/pdf" : "video/*"}
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      setSelectedFile(file);
                      setPreparedUpload(null);
                      setUploadProgress(null);
                      setUploadState("idle");
                      if (file && !uploadTitle) {
                        setUploadTitle(file.name);
                      }
                      if (file && uploadKind === "VIDEO") {
                        void readVideoDurationSec(file).then((duration) => {
                          if (duration && duration > 0) {
                            setUploadDurationSec(String(duration));
                          }
                        });
                      }
                    }}
                  />
                </div>
                <input type="hidden" name="fileName" value={selectedFile?.name ?? ""} />
                <input
                  type="hidden"
                  name="mimeType"
                  value={selectedFile?.type || "application/octet-stream"}
                />
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    onClick={runOneClickUpload}
                    disabled={
                      !selectedFile ||
                      uploadState === "preparing" ||
                      uploadState === "uploading" ||
                      uploadState === "registering"
                    }
                  >
                    원클릭 업로드 (발급+업로드+등록)
                  </Button>
                  <Button
                    submit
                    loading={uploadFetcher.state !== "idle"}
                    disabled={
                      !selectedFile ||
                      registerFetcher.state !== "idle" ||
                      uploadState === "preparing" ||
                      uploadState === "uploading" ||
                      uploadState === "registering"
                    }
                  >
                    1) 업로드 URL 발급
                  </Button>
                  <Button
                    onClick={runUploadAndRegister}
                    disabled={
                      !selectedFile ||
                      !prepared ||
                      uploadFetcher.state !== "idle" ||
                      registerFetcher.state !== "idle" ||
                      uploadState === "preparing" ||
                      uploadState === "uploading" ||
                      uploadState === "registering"
                    }
                  >
                    2) S3 업로드 + 등록
                  </Button>
                  <Button
                    onClick={cancelUpload}
                    tone="critical"
                    disabled={uploadState !== "uploading"}
                  >
                    업로드 취소
                  </Button>
                </InlineStack>
                {prepared ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    준비됨: assetId={prepared.assetId}, s3Key={prepared.s3Key}
                  </Text>
                ) : null}
                {uploadMessage ? (
                  <Text
                    as="p"
                    variant="bodySm"
                    tone={
                      uploadState === "failed"
                        ? "critical"
                        : uploadState === "cancelled"
                          ? "warning"
                          : "subdued"
                    }
                  >
                    {uploadMessage}
                  </Text>
                ) : null}
                {uploadProgress !== null ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    업로드 진행률: {uploadProgress}%
                  </Text>
                ) : null}
              </BlockStack>
            </uploadFetcher.Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              에셋 생성
            </Text>
            <fetcher.Form method="post">
              <BlockStack gap="200">
                <input type="hidden" name="intent" value="create" />
                <Select
                  name="kind"
                  label="Kind"
                  options={[
                    { label: "PDF", value: "PDF" },
                    { label: "VIDEO", value: "VIDEO" },
                  ]}
                />
                <TextField name="title" label="Title" autoComplete="off" requiredIndicator />
                <TextField name="s3Bucket" label="S3 Bucket" autoComplete="off" requiredIndicator />
                <TextField name="s3Key" label="S3 Key" autoComplete="off" requiredIndicator />
                <TextField name="mimeType" label="MIME Type" autoComplete="off" requiredIndicator />
                <TextField name="sizeBytes" type="number" label="Size Bytes" autoComplete="off" />
                <TextField
                  name="durationSec"
                  type="number"
                  label="Duration Sec"
                  autoComplete="off"
                />
                <TextField name="checksumSha256" label="Checksum SHA256" autoComplete="off" />
                <Select
                  name="status"
                  label="Status"
                  options={[
                    { label: "READY", value: "READY" },
                    { label: "UPLOADING", value: "UPLOADING" },
                    { label: "FAILED", value: "FAILED" },
                  ]}
                />
                <InlineStack>
                  <Button submit variant="primary" loading={fetcher.state !== "idle"}>
                    생성
                  </Button>
                </InlineStack>
              </BlockStack>
            </fetcher.Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              에셋 목록
            </Text>
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
              <TextField
                label="Search"
                value={searchValue}
                onChange={setSearchValue}
                autoComplete="off"
              />
              <Select
                label="Kind"
                options={[
                  { label: "All", value: "ALL" },
                  { label: "PDF", value: "PDF" },
                  { label: "VIDEO", value: "VIDEO" },
                ]}
                value={kindFilter}
                onChange={setKindFilter}
              />
              <Select
                label="Usage"
                options={[
                  { label: "All", value: "ALL" },
                  { label: "현재 사용 중", value: "CURRENT" },
                  { label: "미연결", value: "UNASSIGNED" },
                  { label: "여러 카테고리 공유", value: "SHARED" },
                ]}
                value={usageFilter}
                onChange={setUsageFilter}
              />
            </InlineGrid>
            <Text as="p" variant="bodySm" tone="subdued">
              표시 {filteredItems.length} / 전체 {items.length}
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text", "text", "text"]}
              headings={[
                "Title",
                "Kind",
                "MIME",
                "Status",
                "Categories",
                "Usage",
                "S3 Key",
                "Actions",
              ]}
              rows={rows}
            />
          </BlockStack>
        </Card>

        {error ? (
          <Card>
            <Text as="p" variant="bodyMd" tone="critical">
              {error}
            </Text>
          </Card>
        ) : null}
        {fetcher.data?.message ? (
          <Card>
            <Text as="p" variant="bodyMd" tone={fetcher.data.ok ? "success" : "critical"}>
              {fetcher.data.message}
            </Text>
          </Card>
        ) : null}
        {uploadFetcher.data?.message ? (
          <Card>
            <Text as="p" variant="bodyMd" tone={uploadFetcher.data.ok ? "success" : "critical"}>
              {uploadFetcher.data.message}
            </Text>
          </Card>
        ) : null}
        {registerFetcher.data?.message ? (
          <Card>
            <Text as="p" variant="bodyMd" tone={registerFetcher.data.ok ? "success" : "critical"}>
              {registerFetcher.data.message}
            </Text>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
