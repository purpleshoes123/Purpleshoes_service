import { requireGkvAdmin } from "~/lib/gkv/adminRequest.server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Link, useFetcher, useLoaderData, useLocation } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/lib/gkv/adminApi.server";
import { withEmbeddedSearch } from "~/lib/gkv/embeddedPath";

type AssetKind = "PDF" | "VIDEO";

type AssetUsageItem = {
  id: string;
  kind: AssetKind;
  title: string;
  description: string | null;
  isActive: boolean;
  s3Bucket: string;
  s3Key: string;
  mimeType: string;
  sizeBytes: number | null;
  durationSec: number | null;
  thumbnailKey?: string | null;
  status: "UPLOADING" | "READY" | "FAILED";
  createdAt: string;
  updatedAt: string;
  categoryIds: string[];
  categoryPaths: string[];
  usageCategoryCount: number;
  currentCategoryIds: string[];
  currentCategoryPaths: string[];
  isCurrentForCategory?: boolean;
};

type LoaderData = {
  category: {
    id: string;
    name: string;
    slug: string;
    depth: number;
    parentId: string | null;
    isActive: boolean;
    exposeAsGuide: boolean;
    path: string;
  };
  current: {
    pdf: AssetUsageItem | null;
    video: AssetUsageItem | null;
  };
  items: AssetUsageItem[];
  availableAssets: AssetUsageItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null) return "-";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusBadge(asset: Pick<AssetUsageItem, "status" | "isActive">) {
  if (!asset.isActive) return <Badge tone="critical">INACTIVE</Badge>;
  if (asset.status === "READY") return <Badge tone="success">READY</Badge>;
  if (asset.status === "FAILED") return <Badge tone="critical">FAILED</Badge>;
  return <Badge tone="attention">UPLOADING</Badge>;
}

function currentBadge(asset: AssetUsageItem) {
  return asset.isCurrentForCategory ? (
    <Badge tone="success">Current</Badge>
  ) : (
    <Badge tone="attention">Attached</Badge>
  );
}

function usageLabel(asset: AssetUsageItem): string {
  if (asset.usageCategoryCount === 0) return "미연결";
  if (asset.usageCategoryCount === 1) return "이 카테고리만";
  return `${asset.usageCategoryCount}개 카테고리`;
}

function previewDisabledReason(asset: AssetUsageItem): string | null {
  if (asset.status !== "READY") return "READY 상태 파일만 열 수 있습니다.";
  if (!asset.isActive) return "비활성 파일은 열 수 없습니다.";
  if (asset.kind !== "PDF" && asset.kind !== "VIDEO") return "PDF/VIDEO 파일만 열 수 있습니다.";
  return null;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  const categoryId = String(params.categoryId || "");
  try {
    const data = await callGkvAdminApi<Omit<LoaderData, "error">>(
      request,
      `/admin/gkv/categories/${encodeURIComponent(categoryId)}/assets`
    );
    return json<LoaderData>(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "카테고리 파일 정보를 불러오지 못했습니다.";
    return json<LoaderData>(
      {
        category: {
          id: categoryId,
          name: categoryId,
          slug: "",
          depth: 0,
          parentId: null,
          isActive: false,
          exposeAsGuide: false,
          path: categoryId,
        },
        current: { pdf: null, video: null },
        items: [],
        availableAssets: [],
        error: message,
      },
      { status: error instanceof GkvAdminApiError ? error.status : 500 }
    );
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  const categoryId = String(params.categoryId || "");
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const assetId = String(formData.get("assetId") || "");
    if (!assetId) {
      return json<ActionData>({ ok: false, message: "asset id가 필요합니다." }, { status: 400 });
    }

    const result = await callGkvAdminApi<Record<string, unknown>>(
      request,
      `/admin/gkv/categories/${encodeURIComponent(categoryId)}/assets`,
      {
        method: "POST",
        body: JSON.stringify({
          intent,
          assetId,
          force: String(formData.get("force") || "").toLowerCase() === "true",
        }),
      }
    );

    const messageByIntent: Record<string, string> = {
      detach: "이 카테고리에서 파일 연결을 해제했습니다.",
      "delete-asset": "파일을 삭제했습니다.",
      promote: "현재 노출 후보로 올렸습니다.",
      "attach-promote": "기존 미연결 파일을 이 카테고리의 현재 후보로 연결했습니다.",
    };

    return json<ActionData>({
      ok: true,
      message: messageByIntent[intent] ?? "처리했습니다.",
      ...result,
    });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "요청 처리에 실패했습니다.";
    return json<ActionData>({ ok: false, message }, { status: 500 });
  }
};

export default function GkvGuideCategoryAssetsPage() {
  const { category, current, items, availableAssets, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const [selectedExistingAssetId, setSelectedExistingAssetId] = useState(
    availableAssets[0]?.id ?? ""
  );

  useEffect(() => {
    if (selectedExistingAssetId && availableAssets.some((asset) => asset.id === selectedExistingAssetId)) {
      return;
    }
    setSelectedExistingAssetId(availableAssets[0]?.id ?? "");
  }, [availableAssets, selectedExistingAssetId]);

  const pdfItems = items.filter((item) => item.kind === "PDF");
  const videoItems = items.filter((item) => item.kind === "VIDEO");
  const availableOptions = useMemo(
    () =>
      availableAssets.map((asset) => ({
        label: `[${asset.kind}] ${asset.title} (${formatSize(asset.sizeBytes)})`,
        value: asset.id,
      })),
    [availableAssets]
  );

  function renderPreviewButton(asset: AssetUsageItem, size?: "micro") {
    const disabledReason = previewDisabledReason(asset);
    const button = (
      <Button size={size} disabled={Boolean(disabledReason)} accessibilityLabel={disabledReason ?? `${asset.title} 파일 열기`}>
        파일 열기
      </Button>
    );

    if (disabledReason) {
      return button;
    }

    return (
      <Link
        to={toInApp(`/app/gkv/assets/${encodeURIComponent(asset.id)}/preview`)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {button}
      </Link>
    );
  }

  function renderCurrentCard(kind: AssetKind, asset: AssetUsageItem | null) {
    const uploadPath = `/app/gkv/guides/${encodeURIComponent(category.id)}/assets/new?kind=${kind.toLowerCase()}`;
    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">
              Current {kind}
            </Text>
            {asset ? statusBadge(asset) : <Badge tone="critical">MISSING</Badge>}
          </InlineStack>
          {asset ? (
            <BlockStack gap="100">
              <Text as="p" variant="headingSm">
                {asset.title}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued" breakWord>
                {asset.s3Key}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {formatSize(asset.sizeBytes)} · updated {formatDate(asset.updatedAt)} · {usageLabel(asset)}
              </Text>
            </BlockStack>
          ) : (
            <Text as="p" variant="bodyMd" tone="subdued">
              이 카테고리에 노출 가능한 {kind} 파일이 없습니다.
            </Text>
          )}
          <InlineStack gap="200">
            {asset ? renderPreviewButton(asset) : null}
            <Link to={toInApp(uploadPath)}>
              <Button variant={asset ? "secondary" : "primary"}>
                {asset ? "새 파일로 교체" : `${kind} 업로드`}
              </Button>
            </Link>
            {asset ? (
              <fetcher.Form
                method="post"
                onSubmit={(event) => {
                  if (!window.confirm("이 카테고리에서 현재 파일 연결을 해제할까요?")) {
                    event.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="intent" value="detach" />
                <input type="hidden" name="assetId" value={asset.id} />
                <Button submit tone="critical" loading={fetcher.state !== "idle"}>
                  연결 해제
                </Button>
              </fetcher.Form>
            ) : null}
          </InlineStack>
        </BlockStack>
      </Card>
    );
  }

  const rows = items.map((asset) => {
    const canPromote =
      !asset.isCurrentForCategory &&
      asset.status === "READY" &&
      asset.isActive &&
      asset.usageCategoryCount === 1;
    const canDelete = asset.usageCategoryCount <= 1;
    return [
      <InlineStack key={`${asset.id}-current`} gap="100">
        {currentBadge(asset)}
      </InlineStack>,
      asset.kind,
      <BlockStack key={`${asset.id}-title`} gap="050">
        <Text as="span" variant="bodyMd">
          {asset.title}
        </Text>
        <Text as="span" variant="bodySm" tone="subdued" breakWord>
          {asset.id}
        </Text>
      </BlockStack>,
      statusBadge(asset),
      usageLabel(asset),
      formatDate(asset.updatedAt),
      <InlineStack key={`${asset.id}-actions`} gap="200">
        {renderPreviewButton(asset, "micro")}
        {canPromote ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="promote" />
            <input type="hidden" name="assetId" value={asset.id} />
            <Button submit size="micro" loading={fetcher.state !== "idle"}>
              현재로 지정
            </Button>
          </fetcher.Form>
        ) : null}
        <fetcher.Form
          method="post"
          onSubmit={(event) => {
            if (!window.confirm("이 카테고리에서만 파일 연결을 해제할까요?")) {
              event.preventDefault();
            }
          }}
        >
          <input type="hidden" name="intent" value="detach" />
          <input type="hidden" name="assetId" value={asset.id} />
          <Button submit size="micro" loading={fetcher.state !== "idle"}>
            연결 해제
          </Button>
        </fetcher.Form>
        {canDelete ? (
          <fetcher.Form
            method="post"
            onSubmit={(event) => {
              if (!window.confirm("이 파일을 전체 삭제할까요? 되돌릴 수 없습니다.")) {
                event.preventDefault();
              }
            }}
          >
            <input type="hidden" name="intent" value="delete-asset" />
            <input type="hidden" name="assetId" value={asset.id} />
            <Button submit size="micro" tone="critical" loading={fetcher.state !== "idle"}>
              전체 삭제
            </Button>
          </fetcher.Form>
        ) : null}
      </InlineStack>,
    ];
  });

  return (
    <Page
      backAction={{
        content: "GKV Guides",
        url: toInApp("/app/gkv/guides"),
      }}
    >
      <TitleBar title={`GKV Category Files: ${category.name}`} />
      <BlockStack gap="400">
        <Banner tone="info" title={category.path}>
          <Text as="p" variant="bodyMd">
            고객 화면은 이 카테고리에 연결된 READY/ACTIVE 파일 중 가장 최근 업데이트된 PDF와 VIDEO를 사용합니다.
            기존 파일을 안전하게 현재 후보로 올리려면 이 카테고리에만 연결된 파일에서 `현재로 지정`을 사용하세요.
          </Text>
        </Banner>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          {renderCurrentCard("PDF", current.pdf)}
          {renderCurrentCard("VIDEO", current.video)}
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                연결된 PDF
              </Text>
              <Text as="p" variant="headingLg">
                {pdfItems.length}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                연결된 VIDEO
              </Text>
              <Text as="p" variant="headingLg">
                {videoItems.length}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                연결 가능한 미연결 asset
              </Text>
              <Text as="p" variant="headingLg">
                {availableAssets.length}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              기존 미연결 asset 연결
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              READY/ACTIVE 상태이며 다른 카테고리에 연결되지 않은 asset만 표시됩니다. 연결하면 이 카테고리의 현재 후보로 올라갑니다.
            </Text>
            <fetcher.Form method="post">
              <BlockStack gap="200">
                <input type="hidden" name="intent" value="attach-promote" />
                <Select
                  name="assetId"
                  label="Asset"
                  options={
                    availableOptions.length > 0
                      ? availableOptions
                      : [{ label: "연결 가능한 미연결 asset이 없습니다.", value: "" }]
                  }
                  value={selectedExistingAssetId}
                  onChange={setSelectedExistingAssetId}
                  disabled={availableOptions.length === 0}
                />
                <InlineStack>
                  <Button
                    submit
                    variant="primary"
                    disabled={!selectedExistingAssetId}
                    loading={fetcher.state !== "idle"}
                  >
                    연결하고 현재로 지정
                  </Button>
                </InlineStack>
              </BlockStack>
            </fetcher.Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              이 카테고리에 연결된 파일
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
              headings={["Current", "Type", "Title", "Status", "Usage", "Updated", "Actions"]}
              rows={rows}
            />
          </BlockStack>
        </Card>

        {error ? (
          <Banner tone="critical">
            <p>{error}</p>
          </Banner>
        ) : null}
        {fetcher.data?.message ? (
          <Banner tone={fetcher.data.ok ? "success" : "critical"}>
            <p>{fetcher.data.message}</p>
          </Banner>
        ) : null}
      </BlockStack>
    </Page>
  );
}
