import { requireGkvAdmin } from "~/lib/gkv/adminRequest.server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { randomUUID } from "crypto";
import { callGkvAdminApi, GkvAdminApiError } from "~/lib/gkv/adminApi.server";
import type { RestaurantPhotoMeta } from "~/lib/gkv/restaurantPhotoUrls.server";
import {
  processAndUploadRestaurantPhoto,
  RestaurantPhotoUploadError,
} from "~/lib/gkv/restaurantPhotoUpload.server";
import { respond } from "~/lib/respond";

type CategoryItem = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
};

type AreaItem = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
};

type RestaurantItem = {
  id: string;
  name: string;
  areaId: string;
  categoryIds: string[];
  veganRecommended: boolean;
  meatTypes: string[];
  address: string;
  lat: number;
  lng: number;
  kakaoPlaceId: string | null;
  naverPlaceUrl: string | null;
  tags: string[];
  memo: string | null;
  priority: number;
  isActive: boolean;
  photo: RestaurantPhotoMeta | null;
  photoUrl: string | null;
  photoThumbnailUrl: string | null;
};

type LoaderData = {
  mode: "new" | "edit";
  item: RestaurantItem | null;
  categories: CategoryItem[];
  areas: AreaItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  message?: string;
  id?: string;
  photo?: RestaurantPhotoMeta;
  fieldErrors?: Record<string, string>;
  geocode?: { lat: number; lng: number; address: string };
  place?: {
    placeId: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
    phone: string | null;
  };
};

type ActionLogContext = {
  intent: string;
  upload?: {
    resourceId: string;
    resourceType: "restaurant";
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
    if (error.cause instanceof Error) return error.cause.message;
    if (error.cause) return String(error.cause);
  }
  return undefined;
}

function logActionError(request: Request, context: ActionLogContext, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const status = error instanceof RestaurantPhotoUploadError ? error.status : 500;
  const code =
    error instanceof RestaurantPhotoUploadError ? error.code : "GKV_RESTAURANT_ACTION_FAILED";

  console.error(
    JSON.stringify({
      message: "GKV restaurant editor action failed",
      route: "app.gkv.restaurants.$id",
      correlationId: respond.getCorrelationId(request),
      intent: context.intent || null,
      upload: context.upload,
      status,
      code,
      errorName,
      errorMessage,
      causeMessage: getCauseMessage(error),
    })
  );
}

export function createRestaurantEditorLoader(mode: "new" | "edit") {
  return async ({ request, params }: LoaderFunctionArgs) => {
    await requireGkvAdmin(request);
    try {
      const [categoriesRes, areasRes, restaurantRes] = await Promise.all([
        callGkvAdminApi<{ items: CategoryItem[] }>(
          request,
          "/admin/restaurants/categories?includeInactive=true"
        ),
        callGkvAdminApi<{ items: AreaItem[] }>(request, "/admin/restaurants/areas?includeInactive=true"),
        mode === "edit" && params.id
          ? callGkvAdminApi<{ item: RestaurantItem }>(request, `/admin/restaurants/${params.id}`)
          : Promise.resolve<{ item: RestaurantItem } | null>(null),
      ]);

      return json<LoaderData>({
        mode,
        item: restaurantRes?.item ?? null,
        categories: categoriesRes.items,
        areas: areasRes.items,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "맛집 데이터를 불러오지 못했습니다.";
      return json<LoaderData>({
        mode,
        item: null,
        categories: [],
        areas: [],
        error: message,
      });
    }
  };
}

export function createRestaurantEditorAction(mode: "new" | "edit") {
  return async ({ request, params }: ActionFunctionArgs) => {
    await requireGkvAdmin(request);
    const context: ActionLogContext = { intent: "" };

    try {
      const formData = await request.formData();
      const intent = String(formData.get("intent") || "");
      context.intent = intent;

      if (intent === "save") {
        const payload = JSON.parse(String(formData.get("payload") || "{}")) as Record<string, unknown>;
        const path = mode === "edit" ? `/admin/restaurants/${params.id}` : "/admin/restaurants";
        const method = mode === "edit" ? "PUT" : "POST";

        const result = await callGkvAdminApi<{ id: string }>(request, path, {
          method,
          body: JSON.stringify(payload),
        });

        return json<ActionData>({ ok: true, id: result.id, message: "저장을 완료했습니다." });
      }

      if (intent === "upload-photo") {
        const requestedId = String(formData.get("restaurantId") || params.id || "").trim();
        const restaurantId = requestedId || `rest_${randomUUID()}`;
        const fileValue = formData.get("photo");

        if (!(fileValue instanceof Blob) || fileValue.size === 0) {
          return json<ActionData>(
            {
              ok: false,
              message: "업로드할 사진 파일이 필요합니다.",
              fieldErrors: { photo: "업로드할 사진 파일이 필요합니다." },
            },
            { status: 400 }
          );
        }

        context.upload = {
          resourceId: restaurantId,
          resourceType: "restaurant",
          fileName: getFileName(fileValue),
          fileType: fileValue.type || "",
          fileSize: fileValue.size,
        };

        const photo = await processAndUploadRestaurantPhoto({
          resourceId: restaurantId,
          resourceType: "restaurant",
          file: fileValue,
        });

        return json<ActionData>({
          ok: true,
          id: restaurantId,
          photo,
          message: "사진 업로드를 완료했습니다.",
        });
      }

      if (intent === "geocode") {
        const address = String(formData.get("address") || "").trim();
        const data = await callGkvAdminApi<{ address: string; lat: number; lng: number }>(
          request,
          `/admin/kakao/geocode?address=${encodeURIComponent(address)}`
        );
        return json<ActionData>({ ok: true, geocode: data, message: "좌표를 찾았습니다." });
      }

      if (intent === "fetch-place") {
        const placeId = String(formData.get("placeId") || "").trim();
        const data = await callGkvAdminApi<{
          placeId: string;
          name: string;
          address: string;
          lat: number;
          lng: number;
          phone: string | null;
        }>(request, `/admin/kakao/place?placeId=${encodeURIComponent(placeId)}`);

        return json<ActionData>({ ok: true, place: data, message: "장소 정보를 반영했습니다." });
      }

      if (intent === "delete") {
        if (!params.id) {
          return json<ActionData>({ ok: false, message: "id가 필요합니다." }, { status: 400 });
        }

        await callGkvAdminApi<{ id: string }>(request, `/admin/restaurants/${params.id}`, {
          method: "DELETE",
        });

        return json<ActionData>({ ok: true, message: "맛집을 비활성화했습니다." });
      }

      return json<ActionData>({ ok: false, message: "지원하지 않는 작업입니다." }, { status: 400 });
    } catch (error) {
      if (error instanceof GkvAdminApiError) {
        return json<ActionData>(
          {
            ok: false,
            message: error.message,
            fieldErrors:
              (error.details?.fieldErrors as Record<string, string> | undefined) ?? undefined,
          },
          { status: error.status }
        );
      }

      if (error instanceof RestaurantPhotoUploadError) {
        logActionError(request, context, error);
        return json<ActionData>(
          {
            ok: false,
            message: error.message,
            fieldErrors: { photo: error.message },
          },
          { status: error.status }
        );
      }

      logActionError(request, context, error);
      const message = error instanceof Error ? error.message : "요청 처리에 실패했습니다.";
      return json<ActionData>({ ok: false, message }, { status: 500 });
    }
  };
}
