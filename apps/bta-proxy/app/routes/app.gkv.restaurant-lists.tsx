import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { randomUUID } from "crypto";
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
import {
  processAndUploadRestaurantPhoto,
  RestaurantPhotoUploadError,
} from "~/domains/guide-viewer/restaurantPhotoUpload.server.ts";
import type { RestaurantPhotoMeta } from "~/domains/guide-viewer/restaurantPhotoUrls.server.ts";
import { respond } from "~/lib/respond";

type RestaurantListItem = {
  id: string;
  title: string;
  city: string | null;
  country: string | null;
  version: number;
  isActive: boolean;
};

type VeganLevel = "VEGAN" | "VEGETARIAN" | "VEGAN_OPTIONS" | "NONE" | "UNKNOWN";
type HalalLevel = "CERTIFIED" | "MUSLIM_OWNED" | "NO_PORK" | "UNKNOWN" | "NOT_HALAL";
type MeatType = "PORK" | "BEEF" | "CHICKEN" | "LAMB" | "SEAFOOD" | "NONE" | "UNKNOWN";

type RestaurantItem = {
  id: string;
  listId: string;
  name: string;
  category: string | null;
  address: string | null;
  lat: number;
  lng: number;
  tags: string[];
  memo: string | null;
  priority: number;
  mapUrl: string | null;
  photoUrl: string | null;
  photoThumbnailUrl: string | null;
  photo: RestaurantPhotoMeta | null;
  dietary: {
    isVeganOnly: boolean;
    hasVeganOptions: boolean;
    veganLevel: VeganLevel;
    meatTypes: MeatType[];
    halalLevel: HalalLevel;
    notes: string | null;
  } | null;
};

type LoaderData = {
  lists: RestaurantListItem[];
  selectedListId: string | null;
  items: RestaurantItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
};

type ActionLogContext = {
  intent: string;
  upload?: {
    resourceId: string;
    resourceType: "restaurant-item";
    fileName: string | null;
    fileType: string;
    fileSize: number;
  };
};

function getFileName(value: Blob): string | null {
  const maybeName = (value as { name?: unknown }).name;
  return typeof maybeName === "string" && maybeName.trim() ? maybeName : null;
}

function getCauseMessage(error: unknown): string | undefined {
  if (error instanceof RestaurantPhotoUploadError) {
    if (error.cause instanceof Error) {
      return error.cause.message;
    }
    if (error.cause) {
      return String(error.cause);
    }
  }
  return undefined;
}

function logActionError(request: Request, context: ActionLogContext, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const status = error instanceof RestaurantPhotoUploadError ? error.status : 500;
  const code =
    error instanceof RestaurantPhotoUploadError ? error.code : "GKV_RESTAURANT_LISTS_ACTION_FAILED";

  console.error(
    JSON.stringify({
      message: "GKV restaurant list action failed",
      route: "app.gkv.restaurant-lists",
      correlationId: respond.getCorrelationId(request),
      intent: context.intent || null,
      upload: context.upload,
      status,
      code,
      errorName,
      errorMessage,
      causeMessage: getCauseMessage(error),
    }),
  );
}

function parseBool(value: FormDataEntryValue | null): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

function parseIntSafe(value: FormDataEntryValue | null, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseFloatSafe(value: FormDataEntryValue | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsv(value: FormDataEntryValue | null): string[] {
  const text = String(value || "").trim();
  if (!text) {
    return [];
  }
  return text
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const listsRes = await callGkvAdminApi<{ items: RestaurantListItem[] }>(
      request,
      "/admin/gkv/restaurant-lists",
    );
    const url = new URL(request.url);
    const selectedFromQuery = url.searchParams.get("listId");
    const selectedListId =
      selectedFromQuery && listsRes.items.some((item) => item.id === selectedFromQuery)
        ? selectedFromQuery
        : (listsRes.items[0]?.id ?? null);

    if (!selectedListId) {
      return json<LoaderData>({ lists: listsRes.items, selectedListId: null, items: [] });
    }

    const itemsRes = await callGkvAdminApi<{ items: RestaurantItem[] }>(
      request,
      `/admin/gkv/restaurant-lists/${selectedListId}/items`,
    );
    return json<LoaderData>({
      lists: listsRes.items,
      selectedListId,
      items: itemsRes.items,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "식당 리스트 데이터를 불러오지 못했습니다.";
    return json<LoaderData>({ lists: [], selectedListId: null, items: [], error: message });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireGkvAdmin(request);
  const context: ActionLogContext = { intent: "" };

  try {
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    context.intent = intent;
    const id = String(formData.get("id") || "");

    if (intent === "create-list") {
      await callGkvAdminApi<{ id: string }>(request, "/admin/gkv/restaurant-lists", {
        method: "POST",
        body: JSON.stringify({
          title: String(formData.get("title") || ""),
          city: String(formData.get("city") || "") || undefined,
          country: String(formData.get("country") || "") || undefined,
          isActive: parseBool(formData.get("isActive")),
        }),
      });
      return json<ActionData>({ ok: true, message: "식당 리스트를 생성했습니다." });
    }

    if (intent === "delete-list") {
      if (!id) {
        return json<ActionData>({ ok: false, message: "list id가 필요합니다." }, { status: 400 });
      }
      await callGkvAdminApi<{ id: string; deleted: boolean }>(
        request,
        `/admin/gkv/restaurant-lists/${id}`,
        { method: "DELETE" },
      );
      return json<ActionData>({ ok: true, message: "식당 리스트를 삭제했습니다." });
    }

    if (intent === "toggle-list-active") {
      if (!id) {
        return json<ActionData>({ ok: false, message: "list id가 필요합니다." }, { status: 400 });
      }
      await callGkvAdminApi<{ id: string; updated: boolean }>(
        request,
        `/admin/gkv/restaurant-lists/${id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            isActive: parseBool(formData.get("nextActive")),
          }),
        },
      );
      return json<ActionData>({ ok: true, message: "리스트 활성 상태를 변경했습니다." });
    }

    if (intent === "create-item") {
      const listId = String(formData.get("listId") || "");
      if (!listId) {
        return json<ActionData>({ ok: false, message: "listId가 필요합니다." }, { status: 400 });
      }
      const meatType = (String(formData.get("meatType") || "UNKNOWN") || "UNKNOWN") as MeatType;
      const itemId = `ri_${randomUUID()}`;
      const photoValue = formData.get("photo");
      if (photoValue instanceof Blob && photoValue.size > 0) {
        context.upload = {
          resourceId: itemId,
          resourceType: "restaurant-item",
          fileName: getFileName(photoValue),
          fileType: photoValue.type || "",
          fileSize: photoValue.size,
        };
      }
      const photo =
        photoValue instanceof Blob && photoValue.size > 0
          ? await processAndUploadRestaurantPhoto({
              resourceId: itemId,
              resourceType: "restaurant-item",
              file: photoValue,
            })
          : undefined;
      await callGkvAdminApi<{ id: string }>(
        request,
        `/admin/gkv/restaurant-lists/${listId}/items`,
        {
          method: "POST",
          body: JSON.stringify({
            id: itemId,
            name: String(formData.get("name") || ""),
            category: String(formData.get("category") || "") || undefined,
            address: String(formData.get("address") || "") || undefined,
            lat: parseFloatSafe(formData.get("lat")),
            lng: parseFloatSafe(formData.get("lng")),
            tags: parseCsv(formData.get("tags")),
            memo: String(formData.get("memo") || "") || undefined,
            priority: parseIntSafe(formData.get("priority"), 0),
            mapUrl: String(formData.get("mapUrl") || "") || undefined,
            dietary: {
              isVeganOnly: parseBool(formData.get("isVeganOnly")),
              hasVeganOptions: parseBool(formData.get("hasVeganOptions")),
              veganLevel: String(formData.get("veganLevel") || "UNKNOWN"),
              meatTypes: [meatType],
              halalLevel: String(formData.get("halalLevel") || "UNKNOWN"),
              notes: String(formData.get("dietaryNotes") || "") || undefined,
            },
            photo,
          }),
        },
      );
      return json<ActionData>({ ok: true, message: "식당 아이템을 생성했습니다." });
    }

    if (intent === "delete-item") {
      const itemId = String(formData.get("itemId") || "");
      if (!itemId) {
        return json<ActionData>({ ok: false, message: "itemId가 필요합니다." }, { status: 400 });
      }
      await callGkvAdminApi<{ id: string; deleted: boolean }>(
        request,
        `/admin/gkv/restaurant-items/${itemId}`,
        { method: "DELETE" },
      );
      return json<ActionData>({ ok: true, message: "식당 아이템을 삭제했습니다." });
    }

    return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
  } catch (error) {
    if (error instanceof GkvAdminApiError) {
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }

    if (error instanceof RestaurantPhotoUploadError) {
      logActionError(request, context, error);
      return json<ActionData>({ ok: false, message: error.message }, { status: error.status });
    }

    logActionError(request, context, error);
    return json<ActionData>({ ok: false, message: "요청 처리에 실패했습니다." }, { status: 500 });
  }
};

export default function GkvRestaurantListsPage() {
  const { lists, selectedListId, items, error } = useLoaderData<LoaderData>();
  const fetcher = useFetcher<ActionData>();

  const listRows = lists.map((item) => [
    item.title,
    item.city ?? "-",
    item.country ?? "-",
    String(item.version),
    item.isActive ? <Badge tone="success">ACTIVE</Badge> : <Badge tone="critical">INACTIVE</Badge>,
    <InlineStack key={item.id} gap="200">
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="toggle-list-active" />
        <input type="hidden" name="id" value={item.id} />
        <input type="hidden" name="nextActive" value={String(!item.isActive)} />
        <Button submit size="micro">
          {item.isActive ? "비활성화" : "활성화"}
        </Button>
      </fetcher.Form>
      <Button url={`/app/gkv/restaurant-lists?listId=${encodeURIComponent(item.id)}`} size="micro">
        아이템 보기
      </Button>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="delete-list" />
        <input type="hidden" name="id" value={item.id} />
        <Button submit size="micro" tone="critical">
          삭제
        </Button>
      </fetcher.Form>
    </InlineStack>,
  ]);

  const itemRows = items.map((item) => [
    item.photoThumbnailUrl ? (
      <img
        key={`${item.id}-photo`}
        src={item.photoThumbnailUrl}
        alt=""
        style={{
          width: "48px",
          height: "48px",
          objectFit: "cover",
          borderRadius: "6px",
          border: "1px solid #dfe3e8",
        }}
      />
    ) : (
      "-"
    ),
    item.name,
    item.category ?? "-",
    `${item.lat}, ${item.lng}`,
    item.dietary?.veganLevel ?? "-",
    item.dietary?.halalLevel ?? "-",
    String(item.priority),
    <fetcher.Form key={item.id} method="post">
      <input type="hidden" name="intent" value="delete-item" />
      <input type="hidden" name="itemId" value={item.id} />
      <Button submit size="micro" tone="critical">
        삭제
      </Button>
    </fetcher.Form>,
  ]);

  const listOptions = lists.map((item) => ({
    label: `${item.title} (${item.id})`,
    value: item.id,
  }));

  return (
    <Page>
      <TitleBar title="GKV Restaurant Lists" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              식당 리스트 생성
            </Text>
            <fetcher.Form method="post">
              <BlockStack gap="200">
                <input type="hidden" name="intent" value="create-list" />
                <TextField name="title" label="Title" autoComplete="off" requiredIndicator />
                <TextField name="city" label="City" autoComplete="off" />
                <TextField name="country" label="Country" autoComplete="off" />
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
              식당 리스트 목록
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text", "numeric", "text", "text"]}
              headings={["Title", "City", "Country", "Version", "Status", "Actions"]}
              rows={listRows}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              식당 아이템 생성
            </Text>
            <fetcher.Form method="post" encType="multipart/form-data">
              <BlockStack gap="200">
                <input type="hidden" name="intent" value="create-item" />
                <Select
                  name="listId"
                  label="List"
                  options={listOptions}
                  value={selectedListId ?? undefined}
                />
                <TextField name="name" label="Name" autoComplete="off" requiredIndicator />
                <TextField name="category" label="Category" autoComplete="off" />
                <TextField name="address" label="Address" autoComplete="off" />
                <InlineStack gap="200">
                  <TextField name="lat" type="number" label="Latitude" autoComplete="off" />
                  <TextField name="lng" type="number" label="Longitude" autoComplete="off" />
                </InlineStack>
                <TextField name="tags" label="Tags (comma separated)" autoComplete="off" />
                <TextField name="memo" label="Memo" autoComplete="off" />
                <TextField name="priority" type="number" label="Priority" autoComplete="off" />
                <TextField name="mapUrl" label="Map URL" autoComplete="off" />
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    사진은 1:1을 권장하며 저장 시 1080x1080 원본과 512x512 썸네일로 변환됩니다.
                  </Text>
                  <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
                </BlockStack>
                <Select
                  name="isVeganOnly"
                  label="Vegan Only"
                  options={[
                    { label: "false", value: "false" },
                    { label: "true", value: "true" },
                  ]}
                />
                <Select
                  name="hasVeganOptions"
                  label="Has Vegan Options"
                  options={[
                    { label: "false", value: "false" },
                    { label: "true", value: "true" },
                  ]}
                />
                <Select
                  name="veganLevel"
                  label="Vegan Level"
                  options={[
                    { label: "UNKNOWN", value: "UNKNOWN" },
                    { label: "VEGAN", value: "VEGAN" },
                    { label: "VEGETARIAN", value: "VEGETARIAN" },
                    { label: "VEGAN_OPTIONS", value: "VEGAN_OPTIONS" },
                    { label: "NONE", value: "NONE" },
                  ]}
                />
                <Select
                  name="meatType"
                  label="Meat Type"
                  options={[
                    { label: "UNKNOWN", value: "UNKNOWN" },
                    { label: "NONE", value: "NONE" },
                    { label: "PORK", value: "PORK" },
                    { label: "BEEF", value: "BEEF" },
                    { label: "CHICKEN", value: "CHICKEN" },
                    { label: "LAMB", value: "LAMB" },
                    { label: "SEAFOOD", value: "SEAFOOD" },
                  ]}
                />
                <Select
                  name="halalLevel"
                  label="Halal Level"
                  options={[
                    { label: "UNKNOWN", value: "UNKNOWN" },
                    { label: "CERTIFIED", value: "CERTIFIED" },
                    { label: "MUSLIM_OWNED", value: "MUSLIM_OWNED" },
                    { label: "NO_PORK", value: "NO_PORK" },
                    { label: "NOT_HALAL", value: "NOT_HALAL" },
                  ]}
                />
                <TextField name="dietaryNotes" label="Dietary Notes" autoComplete="off" />
                <Button submit variant="primary" loading={fetcher.state !== "idle"}>
                  아이템 생성
                </Button>
              </BlockStack>
            </fetcher.Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {selectedListId ? `아이템 목록 (${selectedListId})` : "아이템 목록"}
            </Text>
            <DataTable
              columnContentTypes={[
                "text",
                "text",
                "text",
                "text",
                "text",
                "text",
                "numeric",
                "text",
              ]}
              headings={[
                "Photo",
                "Name",
                "Category",
                "Lat/Lng",
                "Vegan",
                "Halal",
                "Priority",
                "Actions",
              ]}
              rows={itemRows}
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
      </BlockStack>
    </Page>
  );
}
