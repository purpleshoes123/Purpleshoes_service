import { requireGkvAdmin } from "~/lib/gkv/adminRequest.server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Link, useFetcher, useLoaderData, useLocation } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/lib/gkv/adminApi.server";
import { withEmbeddedSearch } from "~/lib/gkv/embeddedPath";

type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  depth: 1 | 2 | 3;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  exposeAsGuide: boolean;
  pdfAssetCount: number;
  videoAssetCount: number;
};

type LoaderData = {
  items: CategoryItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const data = await callGkvAdminApi<{ items: CategoryItem[] }>(
      request,
      "/admin/gkv/categories",
    );
    return json<LoaderData>({ items: data.items });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "카테고리를 불러오지 못했습니다.";
    return json<LoaderData>({ items: [], error: message });
  }
};

function parseBool(value: FormDataEntryValue | null): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const id = String(formData.get("id") || "");
    if (!id) {
      return json<ActionData>(
        { ok: false, message: "id가 필요합니다." },
        { status: 400 },
      );
    }

    if (intent === "toggle-expose") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/categories/${id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            exposeAsGuide: parseBool(formData.get("nextExpose")),
          }),
        },
      );
      return json<ActionData>({
        ok: true,
        message: "가이드 노출 설정을 변경했습니다.",
      });
    }

    return json<ActionData>(
      { ok: false, message: "지원하지 않는 작업입니다." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>(
        { ok: false, message: error.message },
        { status: error.status },
      );
    }
    return json<ActionData>(
      { ok: false, message: "요청 처리에 실패했습니다." },
      { status: 500 },
    );
  }
};

function buildCategoryPathById(items: CategoryItem[]): Map<string, string> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const cache = new Map<string, string>();
  const resolve = (id: string): string => {
    const cached = cache.get(id);
    if (cached) return cached;
    const item = byId.get(id);
    if (!item) {
      cache.set(id, id);
      return id;
    }
    if (!item.parentId) {
      cache.set(id, item.name);
      return item.name;
    }
    const path = `${resolve(item.parentId)} / ${item.name}`;
    cache.set(id, path);
    return path;
  };
  for (const item of items) {
    resolve(item.id);
  }
  return cache;
}

function buildExposeConfirmText(item: CategoryItem): string | undefined {
  const next = !item.exposeAsGuide;
  if (!next) return undefined;
  if (item.pdfAssetCount > 0 || item.videoAssetCount > 0) return undefined;
  return [
    `이 카테고리는 현재 PDF/VIDEO가 없습니다.`,
    `자산이 추가되면 자동으로 가상 가이드(\`gkv_virtual_shared_${item.id}\`)에 포함됩니다.`,
    `그래도 가이드 노출을 활성화하시겠습니까?`,
  ].join("\n");
}

function renderExposeBadge(item: CategoryItem) {
  return item.exposeAsGuide ? (
    <Badge tone="info">노출 ON</Badge>
  ) : (
    <Badge tone="attention">OFF</Badge>
  );
}

function renderActiveBadge(item: CategoryItem) {
  return item.isActive ? (
    <Badge tone="success">ACTIVE</Badge>
  ) : (
    <Badge tone="critical">INACTIVE</Badge>
  );
}

function renderAssetReadyBadge(item: CategoryItem) {
  return item.pdfAssetCount > 0 || item.videoAssetCount > 0 ? (
    <Badge tone="success">READY</Badge>
  ) : (
    <Badge tone="attention">EMPTY</Badge>
  );
}

const guideRowLayoutStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: "16px",
  flexWrap: "wrap",
} as const;

const guideRowBodyStyle = {
  flex: "1 1 420px",
  minWidth: 0,
} as const;

const guideRowActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  marginLeft: "auto",
  minWidth: "176px",
} as const;

const guidePathStyle = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

function guideRowStyle(index: number) {
  return {
    padding: index === 0 ? "0 0 16px" : "16px 0",
    borderTop: index === 0 ? "0" : "1px solid #e1e3e5",
  } as const;
}

export default function GkvGuidesConsolePage() {
  const { items, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const pendingToggleId =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("id") ?? "") : "";

  const totalCount = items.length;
  const activeCount = items.filter((c) => c.isActive).length;
  const exposedActiveCount = items.filter(
    (c) => c.isActive && c.exposeAsGuide,
  ).length;
  const exposedReadyCount = items.filter(
    (c) =>
      c.isActive &&
      c.exposeAsGuide &&
      (c.pdfAssetCount > 0 || c.videoAssetCount > 0),
  ).length;
  const exposedEmptyCount = exposedActiveCount - exposedReadyCount;

  const pathById = buildCategoryPathById(items);

  const sorted = [...items].sort((a, b) => {
    if (a.exposeAsGuide !== b.exposeAsGuide) {
      return a.exposeAsGuide ? -1 : 1;
    }
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });

  const renderGuideRow = (item: CategoryItem, index: number) => {
    const confirmText = buildExposeConfirmText(item);
    const path = pathById.get(item.id) ?? item.name;
    const assetCount = item.pdfAssetCount + item.videoAssetCount;
    return (
      <div key={item.id} style={guideRowStyle(index)}>
        <div style={guideRowLayoutStyle}>
          <div style={guideRowBodyStyle}>
            <BlockStack gap="150">
              <div title={path} style={guidePathStyle}>
                <Text as="h3" variant="headingSm">
                  {path}
                </Text>
              </div>
              <InlineStack gap="100" wrap blockAlign="center">
                {renderActiveBadge(item)}
                {renderExposeBadge(item)}
                {renderAssetReadyBadge(item)}
                <Badge>Depth {item.depth}</Badge>
                <Badge>PDF {item.pdfAssetCount}</Badge>
                <Badge>VIDEO {item.videoAssetCount}</Badge>
              </InlineStack>
              {item.exposeAsGuide && assetCount === 0 ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  자산이 0건입니다. 업로드하면 이 가이드에 자동 포함됩니다.
                </Text>
              ) : null}
            </BlockStack>
          </div>
          <div style={guideRowActionsStyle}>
            <InlineStack gap="200" align="end" wrap>
              <Link
                to={toInApp(
                  `/app/gkv/guides/${encodeURIComponent(item.id)}/assets`,
                )}
              >
                <Button size="micro" variant="primary">
                  파일 관리
                </Button>
              </Link>
              <fetcher.Form
                method="post"
                onSubmit={(event) => {
                  if (confirmText && !window.confirm(confirmText)) {
                    event.preventDefault();
                  }
                }}
              >
                <input type="hidden" name="intent" value="toggle-expose" />
                <input type="hidden" name="id" value={item.id} />
                <input
                  type="hidden"
                  name="nextExpose"
                  value={String(!item.exposeAsGuide)}
                />
                <Button
                  submit
                  size="micro"
                  loading={pendingToggleId === item.id}
                >
                  {item.exposeAsGuide ? "노출 OFF" : "노출 ON"}
                </Button>
              </fetcher.Form>
              <Link
                to={toInApp(
                  `/app/gkv/guides/${encodeURIComponent(item.id)}/assets/new?kind=pdf`,
                )}
              >
                <Button size="micro">PDF 업로드</Button>
              </Link>
              <Link
                to={toInApp(
                  `/app/gkv/guides/${encodeURIComponent(item.id)}/assets/new?kind=video`,
                )}
              >
                <Button size="micro">VIDEO 업로드</Button>
              </Link>
            </InlineStack>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Page>
      <TitleBar title="GKV Guides" />
      <BlockStack gap="400">
        <Banner tone="info" title="카테고리 = 가이드 콘솔">
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">
              "노출 ON"인 카테고리는 SHARED 가상
              가이드(`gkv_virtual_shared_&lt;id&gt;`)로 자동 생성되어 entitle된
              사용자에게 노출됩니다.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              자산이 0건인 노출 ON 카테고리도 정상 상태입니다. 자산이 추가되면
              자동으로 가상 가이드 구성에 포함됩니다. 카테고리
              이름·정렬·생성/삭제는 GKV Categories 화면에서 관리하세요.
            </Text>
          </BlockStack>
        </Banner>

        <InlineGrid columns={{ xs: 2, md: 4 }} gap="300">
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                전체 카테고리
              </Text>
              <Text as="p" variant="headingLg">
                {totalCount}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                활성 카테고리
              </Text>
              <Text as="p" variant="headingLg">
                {activeCount}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                노출 ON (활성)
              </Text>
              <Text as="p" variant="headingLg">
                {exposedActiveCount}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">
                자산 있음 / 자산 0
              </Text>
              <Text as="p" variant="headingLg">
                {exposedReadyCount} / {exposedEmptyCount}
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              카테고리별 가이드 노출 관리
            </Text>
            {sorted.length > 0 ? (
              <div>{sorted.map(renderGuideRow)}</div>
            ) : (
              <Text as="p" variant="bodyMd" tone="subdued">
                표시할 카테고리가 없습니다.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              관련 화면
            </Text>
            <InlineStack gap="200" wrap>
              <Link to={toInApp("/app/gkv/categories")}>
                <Button>GKV Categories (트리 편집)</Button>
              </Link>
              <Link to={toInApp("/app/gkv/assets")}>
                <Button>GKV Assets (라이브러리)</Button>
              </Link>
            </InlineStack>
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
            <Text
              as="p"
              variant="bodyMd"
              tone={fetcher.data.ok ? "success" : "critical"}
            >
              {fetcher.data.message}
            </Text>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
