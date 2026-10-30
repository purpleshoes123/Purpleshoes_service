import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi, GkvAdminApiError } from "~/domains/guide-viewer/adminApi.server.ts";

type GuideType = "PDF" | "VIDEO" | "BUNDLE";

type GuideItem = {
  id: string;
  title: string;
  type: GuideType;
  thumbnailUrl: string | null;
  isActive: boolean;
};

type AssetItem = {
  id: string;
  title: string;
  kind: "PDF" | "VIDEO";
  status: "UPLOADING" | "READY" | "FAILED";
};

type RestaurantListItem = {
  id: string;
  title: string;
  isActive: boolean;
};

type LoaderData = {
  guides: GuideItem[];
  assets: AssetItem[];
  restaurantLists: RestaurantListItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
};

function parseBool(value: FormDataEntryValue | null): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const [guidesRes, assetsRes, restaurantRes] = await Promise.all([
      callGkvAdminApi<{ items: GuideItem[] }>(request, "/admin/gkv/guides"),
      callGkvAdminApi<{ items: AssetItem[] }>(request, "/admin/gkv/assets"),
      callGkvAdminApi<{ items: RestaurantListItem[] }>(request, "/admin/gkv/restaurant-lists"),
    ]);
    return json<LoaderData>({
      guides: guidesRes.items,
      assets: assetsRes.items,
      restaurantLists: restaurantRes.items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "가이드 데이터를 불러오지 못했습니다.";
    return json<LoaderData>({
      guides: [],
      assets: [],
      restaurantLists: [],
      error: message,
    });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    const id = String(formData.get("id") || "");

    if (intent === "create") {
      await callGkvAdminApi<{ id: string }>(request, "/admin/gkv/guides", {
        method: "POST",
        body: JSON.stringify({
          title: String(formData.get("title") || ""),
          type: String(formData.get("type") || "PDF"),
          thumbnailUrl: String(formData.get("thumbnailUrl") || "") || undefined,
          isActive: parseBool(formData.get("isActive")),
        }),
      });
      return json<ActionData>({ ok: true, message: "가이드를 생성했습니다." });
    }

    if (!id) {
      return json<ActionData>({ ok: false, message: "guide id가 필요합니다." }, { status: 400 });
    }

    if (intent === "delete") {
      await callGkvAdminApi<{ id: string; deleted: boolean }>(request, `/admin/gkv/guides/${id}`, {
        method: "DELETE",
      });
      return json<ActionData>({ ok: true, message: "가이드를 삭제했습니다." });
    }

    if (intent === "toggle-active") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(request, `/admin/gkv/guides/${id}`, {
        method: "PUT",
        body: JSON.stringify({
          isActive: parseBool(formData.get("nextActive")),
        }),
      });
      return json<ActionData>({ ok: true, message: "활성 상태를 변경했습니다." });
    }

    if (intent === "link-assets") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/guides/${id}/assets`,
        {
          method: "PUT",
          body: JSON.stringify({
            pdfAssetId: String(formData.get("pdfAssetId") || "") || undefined,
            videoAssetId: String(formData.get("videoAssetId") || "") || undefined,
          }),
        },
      );
      return json<ActionData>({ ok: true, message: "가이드 에셋 연결을 저장했습니다." });
    }

    if (intent === "link-restaurant-list") {
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/guides/${id}/restaurant-list`,
        {
          method: "PUT",
          body: JSON.stringify({
            restaurantListId: String(formData.get("restaurantListId") || ""),
          }),
        },
      );
      return json<ActionData>({ ok: true, message: "식당 리스트 연결을 저장했습니다." });
    }

    return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }
    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

export default function GkvGuidesLegacyPage() {
  const { guides, assets, restaurantLists, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();

  const pdfOptions = [{ label: "선택 안 함", value: "" }].concat(
    assets
      .filter((asset) => asset.kind === "PDF")
      .map((asset) => ({ label: `${asset.title} (${asset.id})`, value: asset.id })),
  );
  const videoOptions = [{ label: "선택 안 함", value: "" }].concat(
    assets
      .filter((asset) => asset.kind === "VIDEO")
      .map((asset) => ({ label: `${asset.title} (${asset.id})`, value: asset.id })),
  );
  const restaurantListOptions = [{ label: "선택", value: "" }].concat(
    restaurantLists.map((item) => ({ label: `${item.title} (${item.id})`, value: item.id })),
  );

  const rows = guides.map((guide) => [
    guide.title,
    guide.type,
    guide.isActive ? <Badge tone="success">ACTIVE</Badge> : <Badge tone="critical">INACTIVE</Badge>,
    guide.thumbnailUrl ?? "-",
    <InlineStack key={guide.id} gap="200">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="toggle-active" />
        <input type="hidden" name="id" value={guide.id} />
        <input type="hidden" name="nextActive" value={String(!guide.isActive)} />
        <Button submit size="micro">
          {guide.isActive ? "비활성화" : "활성화"}
        </Button>
      </fetcher.Form>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="id" value={guide.id} />
        <Button submit size="micro" tone="critical">
          삭제
        </Button>
      </fetcher.Form>
    </InlineStack>,
  ]);

  return (
    <Page>
      <TitleBar title="GKV Guides (Legacy real-guide editor)" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              가이드 생성
            </Text>
            <fetcher.Form method="post">
              <BlockStack gap="200">
                <input type="hidden" name="intent" value="create" />
                <TextField name="title" label="Title" autoComplete="off" requiredIndicator />
                <Select
                  name="type"
                  label="Type"
                  options={[
                    { label: "PDF", value: "PDF" },
                    { label: "VIDEO", value: "VIDEO" },
                    { label: "BUNDLE", value: "BUNDLE" },
                  ]}
                />
                <TextField name="thumbnailUrl" label="Thumbnail URL" autoComplete="off" />
                <Select
                  name="isActive"
                  label="활성 여부"
                  options={[
                    { label: "활성", value: "true" },
                    { label: "비활성", value: "false" },
                  ]}
                />
                <Button submit variant="primary" loading={fetcher.state !== "idle"}>
                  생성
                </Button>
              </BlockStack>
            </fetcher.Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              가이드 목록
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "text", "text"]}
              headings={["Title", "Type", "Status", "Thumbnail", "Actions"]}
              rows={rows}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              가이드 연결 편집
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              가이드 타입 규칙(PDF/VIDEO/BUNDLE)은 서버에서 검증됩니다.
            </Text>
            {guides.map((guide) => (
              <Card key={guide.id}>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    {guide.title} ({guide.type})
                  </Text>
                  <fetcher.Form method="post">
                    <BlockStack gap="200">
                      <input type="hidden" name="intent" value="link-assets" />
                      <input type="hidden" name="id" value={guide.id} />
                      <Select name="pdfAssetId" label="PDF Asset" options={pdfOptions} />
                      <Select name="videoAssetId" label="VIDEO Asset" options={videoOptions} />
                      <Button submit size="slim">
                        에셋 연결 저장
                      </Button>
                    </BlockStack>
                  </fetcher.Form>
                  {guide.type === "BUNDLE" ? (
                    <fetcher.Form method="post">
                      <BlockStack gap="200">
                        <input type="hidden" name="intent" value="link-restaurant-list" />
                        <input type="hidden" name="id" value={guide.id} />
                        <Select
                          name="restaurantListId"
                          label="Restaurant List"
                          options={restaurantListOptions}
                        />
                        <Button submit size="slim">
                          식당 리스트 연결 저장
                        </Button>
                      </BlockStack>
                    </fetcher.Form>
                  ) : null}
                </BlockStack>
              </Card>
            ))}
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
      </BlockStack>
    </Page>
  );
}
