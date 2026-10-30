import { useFetcher, useLoaderData, useLocation, useNavigate } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";

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

type RestaurantPhotoMeta = {
  original: {
    s3Bucket: string;
    s3Key: string;
    mimeType: "image/jpeg";
    sizeBytes: number | null;
    status: "READY";
  };
  thumbnail: {
    s3Bucket: string;
    s3Key: string;
    mimeType: "image/jpeg";
    sizeBytes: number | null;
    status: "READY";
  };
};

const MEAT_TYPES = ["BEEF", "PORK", "CHICKEN", "FISH", "OTHER"] as const;

type MeatType = (typeof MEAT_TYPES)[number];

function parseCsv(text: string): string[] {
  return text
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeError(error: unknown): { message: string; fieldErrors?: Record<string, string> } {
  if (error && typeof error === "object") {
    const maybe = error as { message?: string; fieldErrors?: Record<string, string> };
    return {
      message: maybe.message ?? "요청 처리에 실패했습니다.",
      fieldErrors: maybe.fieldErrors,
    };
  }
  return { message: "요청 처리에 실패했습니다." };
}

type PendingAction = {
  resolve: (value: ActionData) => void;
  reject: (reason: unknown) => void;
  started: boolean;
};

type SavePhase = "idle" | "uploading-photo" | "saving";

export function RestaurantEditorPage() {
  const { mode, item, categories, areas, error } = useLoaderData<LoaderData>();
  const actionFetcher = useFetcher<ActionData>();
  const pendingActionRef = useRef<PendingAction | null>(null);
  const isEdit = mode === "edit";
  const navigate = useNavigate();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);

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

  const postAction = useCallback(
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
    [actionFetcher],
  );

  const [name, setName] = useState(item?.name ?? "");
  const [areaId, setAreaId] = useState(item?.areaId ?? "");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(item?.categoryIds ?? []);
  const [veganRecommended, setVeganRecommended] = useState(item?.veganRecommended ?? false);
  const [selectedMeatTypes, setSelectedMeatTypes] = useState<MeatType[]>(
    (item?.meatTypes ?? []).filter((value): value is MeatType =>
      MEAT_TYPES.includes(value as MeatType),
    ),
  );
  const [address, setAddress] = useState(item?.address ?? "");
  const [lat, setLat] = useState(item?.lat ? String(item.lat) : "");
  const [lng, setLng] = useState(item?.lng ? String(item.lng) : "");
  const [kakaoPlaceId, setKakaoPlaceId] = useState(item?.kakaoPlaceId ?? "");
  const [naverPlaceUrl, setNaverPlaceUrl] = useState(item?.naverPlaceUrl ?? "");
  const [tags, setTags] = useState((item?.tags ?? []).join(", "));
  const [memo, setMemo] = useState(item?.memo ?? "");
  const [priority, setPriority] = useState(String(item?.priority ?? 0));
  const [isActive, setIsActive] = useState(item?.isActive ?? true);
  const [restaurantId, setRestaurantId] = useState(item?.id ?? "");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoMeta, setPhotoMeta] = useState<RestaurantPhotoMeta | null>(item?.photo ?? null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(
    item?.photoThumbnailUrl ?? item?.photoUrl ?? null,
  );
  const [photoNeedsUpload, setPhotoNeedsUpload] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ tone: "success" | "critical"; message: string } | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");

  useEffect(() => {
    if (!photoFile) {
      return;
    }
    const nextUrl = URL.createObjectURL(photoFile);
    setPhotoPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [photoFile]);

  const areaOptions = useMemo(
    () =>
      [{ label: "지역 선택", value: "" }].concat(
        areas.map((area) => ({ label: area.name, value: area.id })),
      ),
    [areas],
  );
  const selectedCategories = useMemo(
    () => categories.filter((category) => selectedCategoryIds.includes(category.id)),
    [categories, selectedCategoryIds],
  );
  const hasValidLat = Boolean(lat) && !Number.isNaN(Number(lat));
  const hasValidLng = Boolean(lng) && !Number.isNaN(Number(lng));
  const missingRequiredCount = [
    !name.trim(),
    !areaId,
    selectedCategoryIds.length === 0,
    !address.trim(),
    !hasValidLat,
    !hasValidLng,
  ].filter(Boolean).length;
  const canSubmit = missingRequiredCount === 0;
  const saveButtonLabel =
    savePhase === "uploading-photo"
      ? "사진 업로드 중"
      : savePhase === "saving"
        ? "저장 중"
        : "저장";
  const photoStatus = photoNeedsUpload
    ? { tone: "attention" as const, label: "저장 시 업로드" }
    : photoMeta
      ? { tone: "success" as const, label: "업로드 완료" }
      : { tone: "info" as const, label: "사진 없음" };
  const checklistItems = [
    { label: "이름", done: Boolean(name.trim()) },
    { label: "지역", done: Boolean(areaId) },
    { label: "카테고리", done: selectedCategoryIds.length > 0 },
    { label: "주소", done: Boolean(address.trim()) },
    { label: "위도", done: hasValidLat },
    { label: "경도", done: hasValidLng },
  ];
  const placeSummary =
    name.trim() && address.trim() && hasValidLat && hasValidLng
      ? `${name.trim()} · ${address.trim()} · ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`
      : null;

  function toggleCategory(categoryId: string, checked: boolean) {
    setSelectedCategoryIds((prev) => {
      if (checked) {
        if (prev.includes(categoryId)) {
          return prev;
        }
        return [...prev, categoryId];
      }
      return prev.filter((id) => id !== categoryId);
    });
  }

  function toggleMeatType(meatType: MeatType, checked: boolean) {
    setSelectedMeatTypes((prev) => {
      if (checked) {
        if (prev.includes(meatType)) {
          return prev;
        }
        return [...prev, meatType];
      }
      return prev.filter((value) => value !== meatType);
    });
  }

  async function handleGeocode() {
    if (!address.trim()) {
      setBanner({ tone: "critical", message: "주소를 먼저 입력해 주세요." });
      return;
    }

    try {
      const fd = new FormData();
      fd.set("intent", "geocode");
      fd.set("address", address.trim());
      const data = await postAction(fd);
      if (data.geocode) {
        setLat(String(data.geocode.lat));
        setLng(String(data.geocode.lng));
      }
      setBanner({ tone: "success", message: data.message || "좌표를 반영했습니다." });
    } catch (error) {
      const normalized = normalizeError(error);
      setBanner({ tone: "critical", message: normalized.message });
    }
  }

  async function handleFetchPlace() {
    if (!kakaoPlaceId.trim()) {
      setBanner({ tone: "critical", message: "Kakao placeId를 입력해 주세요." });
      return;
    }

    try {
      const fd = new FormData();
      fd.set("intent", "fetch-place");
      fd.set("placeId", kakaoPlaceId.trim());
      const data = await postAction(fd);
      if (data.place) {
        if (!name.trim()) {
          setName(data.place.name);
        }
        if (!address.trim()) {
          setAddress(data.place.address);
        }
        setLat(String(data.place.lat));
        setLng(String(data.place.lng));
      }
      setBanner({ tone: "success", message: data.message || "장소 정보를 반영했습니다." });
    } catch (error) {
      const normalized = normalizeError(error);
      setBanner({ tone: "critical", message: normalized.message });
    }
  }

  async function uploadSelectedPhoto(file: File, currentRestaurantId: string): Promise<ActionData> {
    setFieldErrors((prev) => {
      const { photo: _photo, ...rest } = prev;
      return rest;
    });

    const fd = new FormData();
    fd.set("intent", "upload-photo");
    fd.set("restaurantId", currentRestaurantId);
    fd.set("photo", file, file.name);
    const data = await postAction(fd);

    if (!data.photo) {
      throw { message: "사진 업로드 응답이 올바르지 않습니다." };
    }

    return data;
  }

  function handleRemovePhoto() {
    setPhotoFile(null);
    setPhotoMeta(null);
    setPhotoPreviewUrl(null);
    setPhotoNeedsUpload(false);
    setBanner({ tone: "success", message: "저장 시 사진 연결이 제거됩니다." });
  }

  async function handleSave() {
    const nextFieldErrors: Record<string, string> = {};

    if (!name.trim()) {
      nextFieldErrors.name = "이름은 필수입니다.";
    }
    if (!areaId) {
      nextFieldErrors.areaId = "Area를 선택해 주세요.";
    }
    if (selectedCategoryIds.length === 0) {
      nextFieldErrors.categoryIds = "카테고리를 선택해 주세요.";
    }
    if (!address.trim()) {
      nextFieldErrors.address = "주소는 필수입니다.";
    }
    if (!lat || Number.isNaN(Number(lat))) {
      nextFieldErrors.lat = "유효한 위도를 입력해 주세요.";
    }
    if (!lng || Number.isNaN(Number(lng))) {
      nextFieldErrors.lng = "유효한 경도를 입력해 주세요.";
    }

    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0) {
      setBanner({ tone: "critical", message: "필수 항목을 확인해 주세요." });
      return;
    }

    try {
      setSaving(true);
      let nextRestaurantId = restaurantId || item?.id || "";
      let nextPhotoMeta = photoMeta;

      if (photoNeedsUpload && photoFile) {
        setUploadingPhoto(true);
        setSavePhase("uploading-photo");
        const uploadResult = await uploadSelectedPhoto(photoFile, nextRestaurantId);
        if (uploadResult.id) {
          nextRestaurantId = uploadResult.id;
          setRestaurantId(uploadResult.id);
        }
        nextPhotoMeta = uploadResult.photo ?? null;
        setPhotoMeta(nextPhotoMeta);
        setPhotoNeedsUpload(false);
        setUploadingPhoto(false);
      }

      setSavePhase("saving");
      const fd = new FormData();
      fd.set("intent", "save");
      fd.set(
        "payload",
        JSON.stringify({
          ...(item?.id ? { id: item.id } : {}),
          ...(!item?.id && nextRestaurantId ? { id: nextRestaurantId } : {}),
          name: name.trim(),
          areaId,
          categoryIds: selectedCategoryIds,
          veganRecommended,
          meatTypes: selectedMeatTypes,
          address: address.trim(),
          lat: Number(lat),
          lng: Number(lng),
          kakaoPlaceId: kakaoPlaceId.trim() || undefined,
          naverPlaceUrl: naverPlaceUrl.trim(),
          tags: parseCsv(tags),
          memo: memo.trim() || undefined,
          priority: Number(priority || 0),
          isActive,
          photo: nextPhotoMeta,
        }),
      );

      const data = await postAction(fd);
      setFieldErrors({});
      setBanner({ tone: "success", message: data.message || "저장을 완료했습니다." });

      if (!isEdit && data.id) {
        navigate(toInApp(`/app/gkv/restaurants/${encodeURIComponent(data.id)}`));
      }
    } catch (error) {
      const normalized = normalizeError(error);
      setFieldErrors(normalized.fieldErrors ?? {});
      setBanner({ tone: "critical", message: normalized.message });
    } finally {
      setSaving(false);
      setUploadingPhoto(false);
      setSavePhase("idle");
    }
  }

  async function handleDelete() {
    if (!isEdit) {
      return;
    }
    if (!window.confirm("정말 비활성화하시겠습니까?")) {
      return;
    }

    try {
      const fd = new FormData();
      fd.set("intent", "delete");
      await postAction(fd);
      navigate(toInApp("/app/gkv/restaurants"));
    } catch (error) {
      const normalized = normalizeError(error);
      setBanner({ tone: "critical", message: normalized.message });
    }
  }

  return (
    <Page>
      <TitleBar title={`맛집 ${isEdit ? "수정" : "등록"}`} />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start" gap="300">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h1" variant="headingLg">
                맛집 {isEdit ? "수정" : "등록"}
              </Text>
              <Badge tone={canSubmit ? "success" : "attention"}>
                {canSubmit ? "저장 가능" : `필수 ${missingRequiredCount}개 필요`}
              </Badge>
              <Badge tone={photoStatus.tone}>{photoStatus.label}</Badge>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              장소 정보를 먼저 채우고, 사진과 분류를 확인한 뒤 저장합니다.
            </Text>
          </BlockStack>
          <InlineStack gap="200" align="end">
            <Button onClick={() => navigate(toInApp("/app/gkv/restaurants"))}>Back</Button>
            <Button
              variant="primary"
              onClick={handleSave}
              loading={saving}
              disabled={saving || uploadingPhoto}
            >
              {saveButtonLabel}
            </Button>
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
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  장소 불러오기
                </Text>
                <InlineStack gap="200" blockAlign="end" align="space-between">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Kakao placeId (기존 장소 정보 조회용)"
                      autoComplete="off"
                      value={kakaoPlaceId}
                      onChange={setKakaoPlaceId}
                    />
                    <TextField
                      label="네이버 지도 장소 상세 / 공유 링크"
                      autoComplete="off"
                      value={naverPlaceUrl}
                      onChange={setNaverPlaceUrl}
                      error={fieldErrors.naverPlaceUrl}
                      helpText="네이버 지도에서 해당 업체/명소의 상세 화면 → 공유 → 링크 복사. Web과 App의 Details에 공통 적용됩니다. 비워두면 장소명과 주소로 검색합니다."
                    />
                  </div>
                  <Button
                    onClick={handleFetchPlace}
                    loading={actionFetcher.state !== "idle" && !saving}
                  >
                    불러오기
                  </Button>
                </InlineStack>
                {placeSummary ? (
                  <Text as="p" variant="bodySm" tone="subdued" breakWord>
                    {placeSummary}
                  </Text>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  기본 정보
                </Text>

                <TextField
                  label="이름"
                  autoComplete="off"
                  value={name}
                  onChange={setName}
                  error={fieldErrors.name}
                />

                <InlineStack gap="200" blockAlign="end" align="space-between">
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="주소"
                      autoComplete="off"
                      value={address}
                      onChange={setAddress}
                      error={fieldErrors.address}
                    />
                  </div>
                  <Button
                    onClick={handleGeocode}
                    loading={actionFetcher.state !== "idle" && !saving}
                  >
                    좌표 찾기
                  </Button>
                </InlineStack>

                <InlineGrid columns={{ xs: 1, md: 2 }} gap="200">
                  <TextField
                    label="Latitude"
                    type="number"
                    autoComplete="off"
                    value={lat}
                    onChange={setLat}
                    error={fieldErrors.lat}
                  />
                  <TextField
                    label="Longitude"
                    type="number"
                    autoComplete="off"
                    value={lng}
                    onChange={setLng}
                    error={fieldErrors.lng}
                  />
                </InlineGrid>

                <TextField
                  label="Tags"
                  autoComplete="off"
                  value={tags}
                  onChange={setTags}
                  placeholder="local, noodles"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  분류와 식단
                </Text>

                <Select
                  label="지역"
                  options={areaOptions}
                  value={areaId}
                  onChange={setAreaId}
                  error={fieldErrors.areaId}
                />

                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">
                      카테고리
                    </Text>
                    <Badge>{selectedCategoryIds.length}개 선택</Badge>
                  </InlineStack>
                  {selectedCategories.length > 0 ? (
                    <InlineStack gap="100">
                      {selectedCategories.map((category) => (
                        <Badge key={category.id} tone={category.isActive ? "info" : "attention"}>
                          {category.name}
                        </Badge>
                      ))}
                    </InlineStack>
                  ) : null}
                  {fieldErrors.categoryIds ? (
                    <Text as="p" variant="bodySm" tone="critical">
                      {fieldErrors.categoryIds}
                    </Text>
                  ) : null}
                  <div style={{ maxHeight: "220px", overflow: "auto" }}>
                    <BlockStack gap="100">
                      {categories.map((category) => (
                        <Checkbox
                          key={category.id}
                          label={`${category.name}${category.isActive ? "" : " (inactive)"}`}
                          checked={selectedCategoryIds.includes(category.id)}
                          onChange={(checked) => toggleCategory(category.id, checked)}
                        />
                      ))}
                    </BlockStack>
                  </div>
                </BlockStack>

                <Checkbox
                  label="Vegan recommended"
                  checked={veganRecommended}
                  onChange={setVeganRecommended}
                />

                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Meat Types
                  </Text>
                  <InlineStack gap="200">
                    {MEAT_TYPES.map((meatType) => (
                      <Checkbox
                        key={meatType}
                        label={meatType}
                        checked={selectedMeatTypes.includes(meatType)}
                        onChange={(checked) => toggleMeatType(meatType, checked)}
                      />
                    ))}
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  메모
                </Text>
                <TextField
                  label="Memo"
                  labelHidden
                  autoComplete="off"
                  multiline={4}
                  value={memo}
                  onChange={setMemo}
                />
              </BlockStack>
            </Card>
          </BlockStack>

          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    대표 사진
                  </Text>
                  <Badge tone={photoStatus.tone}>{photoStatus.label}</Badge>
                </InlineStack>

                <div
                  style={{
                    width: "100%",
                    aspectRatio: "1 / 1",
                    background: "#f6f6f7",
                    border: "1px solid #dfe3e8",
                    borderRadius: "8px",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {photoPreviewUrl ? (
                    <img
                      src={photoPreviewUrl}
                      alt={name ? `${name} 대표 사진` : "맛집 대표 사진"}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "cover",
                        display: "block",
                      }}
                    />
                  ) : (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      등록된 사진이 없습니다.
                    </Text>
                  )}
                </div>

                <Text as="p" variant="bodySm" tone="subdued">
                  JPG/PNG/WebP · 1:1 권장 · 저장 시 1080/512 JPEG 생성
                </Text>

                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={saving || uploadingPhoto}
                  onChange={(event) => {
                    const nextFile = event.target.files?.[0] ?? null;
                    setPhotoFile(nextFile);
                    setPhotoNeedsUpload(Boolean(nextFile));
                    setFieldErrors((prev) => {
                      const { photo: _photo, ...rest } = prev;
                      return rest;
                    });
                  }}
                />
                {fieldErrors.photo ? (
                  <Text as="p" variant="bodySm" tone="critical">
                    {fieldErrors.photo}
                  </Text>
                ) : null}
                <InlineStack gap="200">
                  <Button onClick={handleRemovePhoto} disabled={saving || uploadingPhoto}>
                    제거
                  </Button>
                </InlineStack>
                {photoMeta ? (
                  <details>
                    <summary>기술 정보</summary>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued" breakWord>
                        original: {photoMeta.original.s3Key}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued" breakWord>
                        thumbnail: {photoMeta.thumbnail.s3Key}
                      </Text>
                    </BlockStack>
                  </details>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  저장 전 체크
                </Text>
                <BlockStack gap="150">
                  {checklistItems.map((check) => (
                    <InlineStack key={check.label} align="space-between" blockAlign="center">
                      <Text as="span" variant="bodyMd">
                        {check.label}
                      </Text>
                      <Badge tone={check.done ? "success" : "attention"}>
                        {check.done ? "완료" : "필요"}
                      </Badge>
                    </InlineStack>
                  ))}
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="span" variant="bodyMd">
                      사진
                    </Text>
                    <Badge tone={photoStatus.tone}>{photoStatus.label}</Badge>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  운영 설정
                </Text>
                <TextField
                  label="Priority"
                  type="number"
                  autoComplete="off"
                  value={priority}
                  onChange={setPriority}
                />
                <Checkbox label="Active" checked={isActive} onChange={setIsActive} />
                {isEdit ? (
                  <Button
                    tone="critical"
                    onClick={handleDelete}
                    disabled={saving || uploadingPhoto}
                  >
                    Deactivate
                  </Button>
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
