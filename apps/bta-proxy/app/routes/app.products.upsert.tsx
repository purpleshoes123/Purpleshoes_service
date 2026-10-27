import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData } from "react-router";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  Collapsible,
  DataTable,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
  Banner,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  canPublishProduct,
  listPublications,
  publishProductToChannels,
  setProductActive,
} from "~/lib/adminPublishProduct";
import {
  auditLog,
  generateExternalKey,
  upsertTravelProduct,
} from "~/lib/adminProductUpsertFlow";
import type { StepEntry } from "~/lib/adminProductUpsertFlow/stepLog";
import type { UpsertTravelProductInput } from "~/lib/adminProductUpsertFlow/types";
import {
  loadPricingTableFromVariants,
  loadProductByExternalKey,
  loadProductByProductId,
} from "~/lib/adminProductLoad";
import type {
  BookingMode,
  PriceTable,
  TicketType,
  Weekday,
} from "~/lib/adminProductUpsert/types";
import { toTierPriceMatrix, upsertTierVariants } from "~/lib/adminVariantUpsert";
import {
  UploadError,
  validateUploadInput,
  type UploadInput,
} from "~/lib/adminFileUpload";
import { StepLogger } from "~/lib/adminProductUpsertFlow/stepLog";

type PublicationItem = Awaited<ReturnType<typeof listPublications>>[number];

type LoaderData = {
  publications: PublicationItem[];
  error?: string;
};

type ActionData = {
  ok: boolean;
  intent: string;
  message?: string;
  productId?: string;
  mode?: "CREATE" | "UPDATE";
  published?: boolean;
  steps?: StepEntry[];
  loadResult?: Awaited<ReturnType<typeof loadProductByExternalKey>> | null;
  pricingTable?: Awaited<ReturnType<typeof loadPricingTableFromVariants>> | null;
  pricingWarnings?: {
    missingCells: string[];
    zeroPriceCells: string[];
  };
  externalKey?: string;
};

type PriceRow = {
  tier: number;
  adult: string;
  child: string;
  infant: string;
};

const WEEKDAYS: Array<{ value: Weekday; label: string }> = [
  { value: "mon", label: "Mon" },
  { value: "tue", label: "Tue" },
  { value: "wed", label: "Wed" },
  { value: "thu", label: "Thu" },
  { value: "fri", label: "Fri" },
  { value: "sat", label: "Sat" },
  { value: "sun", label: "Sun" },
];

const TICKET_TYPES: TicketType[] = ["adult", "child", "infant"];

function parseNumber(value: FormDataEntryValue | null): number {
  if (value == null) return Number.NaN;
  const raw = String(value).trim();
  if (!raw) return Number.NaN;
  return Number(raw);
}

function parseText(value: FormDataEntryValue | null): string {
  return value == null ? "" : String(value);
}

function isFile(value: FormDataEntryValue | null): value is File {
  return value instanceof File && value.size > 0;
}

async function toUploadInput(file: File): Promise<UploadInput> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return validateUploadInput({
    filename: file.name,
    mimeType: file.type as UploadInput["mimeType"],
    sizeBytes: file.size,
    data: buffer,
  });
}

function buildPricingTable(maxPax: number, formData: FormData): PriceTable {
  const tiers: PriceTable["tiers"] = [];
  if (!Number.isInteger(maxPax) || maxPax < 1) {
    return { tiers };
  }

  for (let tier = 1; tier <= maxPax; tier += 1) {
    const cells = TICKET_TYPES.map((ticketType) => {
      const raw = parseText(formData.get(`price_${tier}_${ticketType}`));
      const unitPrice = raw.trim() === "" ? Number.NaN : Number(raw);
      return { ticketType, unitPrice };
    });
    tiers.push({ paxTier: tier, cells });
  }

  return { tiers };
}

async function buildUpsertInput(formData: FormData): Promise<UpsertTravelProductInput> {
  const externalKey = parseText(formData.get("externalKey"));
  const title = parseText(formData.get("title"));
  const descriptionHtml = parseText(formData.get("descriptionHtml"));
  const maxPax = parseNumber(formData.get("maxPax"));
  const bookingMode = parseText(formData.get("bookingMode")) as BookingMode;
  const poolKey = parseText(formData.get("poolKey"));
  const guideUnitsRequired = parseNumber(formData.get("guideUnitsRequired"));
  const startTimeLabel = parseText(formData.get("startTimeLabel"));
  const bookingWindowDays = parseNumber(formData.get("bookingWindowDays"));
  const operatingWeekdays = formData
    .getAll("operatingWeekdays")
    .map((value) => String(value)) as Weekday[];
  const blackoutDates = formData
    .getAll("blackoutDates")
    .map((value) => String(value));
  const publicationIds = formData
    .getAll("publicationIds")
    .map((value) => String(value))
    .filter(Boolean);

  const heroFileField = formData.get("heroMedia");
  const categoryFileField = formData.get("categoryImage");
  const galleryFileFields = formData.getAll("travelGallery");

  const heroFile = isFile(heroFileField) ? heroFileField : null;
  const categoryImageFile = isFile(categoryFileField) ? categoryFileField : null;
  const travelGalleryFiles = galleryFileFields.filter(isFile);

  const heroUpload = heroFile ? await toUploadInput(heroFile) : undefined;
  const categoryUpload = categoryImageFile
    ? await toUploadInput(categoryImageFile)
    : undefined;
  const galleryUploads =
    travelGalleryFiles.length > 0
      ? await Promise.all(travelGalleryFiles.map(toUploadInput))
      : undefined;

  const pricingTable = buildPricingTable(
    Number.isFinite(maxPax) ? Math.trunc(maxPax) : 0,
    formData
  );

  return {
    externalKey,
    title,
    descriptionHtml,
    maxPax,
    bookingMode,
    poolKey,
    guideUnitsRequired,
    startTimeLabel,
    bookingWindowDays,
    operatingWeekdays,
    blackoutDates,
    pricingTable,
    heroMedia: heroFile
      ? {
          filename: heroFile.name,
          mimeType: heroFile.type as UploadInput["mimeType"],
          sizeBytes: heroFile.size,
        }
      : undefined,
    categoryImage: categoryImageFile
      ? {
          filename: categoryImageFile.name,
          mimeType: categoryImageFile.type as UploadInput["mimeType"],
          sizeBytes: categoryImageFile.size,
        }
      : undefined,
    travelGallery:
      travelGalleryFiles.length > 0
        ? travelGalleryFiles.map((file) => ({
            filename: file.name,
            mimeType: file.type as UploadInput["mimeType"],
            sizeBytes: file.size,
          }))
        : undefined,
    publicationIds: publicationIds.length > 0 ? publicationIds : undefined,
    heroFile: heroUpload,
    categoryImageFile: categoryUpload,
    travelGalleryFiles: galleryUploads,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  let publications: PublicationItem[] = [];
  let error: string | undefined;

  try {
    publications = await listPublications(auth.admin);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error = message || "publications 조회 실패";
  }

  return json<LoaderData>({ publications, ...(error ? { error } : {}) });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const startTime = Date.now();

  if (intent === "generate_external_key") {
    try {
      const externalKey = await generateExternalKey(auth.admin);
      return json<ActionData>({
        ok: true,
        intent,
        externalKey,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json<ActionData>(
        { ok: false, intent, message },
        { status: 500 }
      );
    }
  }

  if (intent === "load_by_external_key") {
    const externalKey = parseText(formData.get("externalKey"));
    if (!externalKey) {
      return json<ActionData>(
        { ok: false, intent, message: "externalKey는 필수입니다." },
        { status: 400 }
      );
    }
    try {
      const loadResult = await loadProductByExternalKey(auth.admin, externalKey);
      if (!loadResult) {
        return json<ActionData>(
          { ok: false, intent, message: "externalKey를 찾을 수 없습니다." },
          { status: 404 }
        );
      }

      let pricingTable: ActionData["pricingTable"] = null;
      let pricingWarnings: ActionData["pricingWarnings"] = undefined;
      if (loadResult.maxPax) {
        const pricingResult = await loadPricingTableFromVariants(
          auth.admin,
          loadResult.productId,
          loadResult.maxPax
        );
        pricingTable = pricingResult;
        pricingWarnings = {
          missingCells: pricingResult.missingCells,
          zeroPriceCells: pricingResult.zeroPriceCells,
        };
      }

      return json<ActionData>({
        ok: true,
        intent,
        loadResult,
        pricingTable,
        pricingWarnings,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json<ActionData>(
        { ok: false, intent, message },
        { status: 500 }
      );
    }
  }

  if (intent === "load_by_product_id") {
    const productId = parseText(formData.get("productId"));
    if (!productId) {
      return json<ActionData>(
        { ok: false, intent, message: "productId는 필수입니다." },
        { status: 400 }
      );
    }
    try {
      const loadResult = await loadProductByProductId(auth.admin, productId);
      if (!loadResult.externalKey) {
        return json<ActionData>(
          {
            ok: false,
            intent,
            message: "선택한 상품에 external_key metafield가 없습니다.",
          },
          { status: 404 }
        );
      }

      let pricingTable: ActionData["pricingTable"] = null;
      let pricingWarnings: ActionData["pricingWarnings"] = undefined;
      if (loadResult.maxPax) {
        const pricingResult = await loadPricingTableFromVariants(
          auth.admin,
          loadResult.productId,
          loadResult.maxPax
        );
        pricingTable = pricingResult;
        pricingWarnings = {
          missingCells: pricingResult.missingCells,
          zeroPriceCells: pricingResult.zeroPriceCells,
        };
      }

      return json<ActionData>({
        ok: true,
        intent,
        loadResult,
        pricingTable,
        pricingWarnings,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json<ActionData>(
        { ok: false, intent, message },
        { status: 500 }
      );
    }
  }

  if (intent === "publish_only") {
    const productId = parseText(formData.get("productId"));
    const maxPax = parseNumber(formData.get("maxPax"));
    const publicationIds = formData
      .getAll("publicationIds")
      .map((value) => String(value))
      .filter(Boolean);

    if (!productId) {
      return json<ActionData>(
        { ok: false, intent, message: "productId가 필요합니다." },
        { status: 400 }
      );
    }
    if (!Number.isInteger(maxPax) || maxPax < 1) {
      return json<ActionData>(
        { ok: false, intent, message: "max_pax가 유효하지 않습니다." },
        { status: 400 }
      );
    }
    if (publicationIds.length === 0) {
      return json<ActionData>(
        { ok: false, intent, message: "publicationIds가 필요합니다." },
        { status: 400 }
      );
    }

    const steps = new StepLogger();
    try {
      const gate = await canPublishProduct(auth.admin, productId, maxPax);
      if (!gate.ok) {
        const error = new Error(`publish 게이트 실패: ${gate.reasons.join(", ")}`);
        steps.addFail("canPublishProduct", error);
        throw error;
      }
      steps.addOk("canPublishProduct");

      const activeResult = await setProductActive(auth.admin, productId);
      steps.addOk("setProductActive", { status: activeResult.status });

      const publishResult = await publishProductToChannels(
        auth.admin,
        productId,
        publicationIds
      );
      steps.addOk("publishProductToChannels", {
        publishableId: publishResult.publishableId,
      });

      auditLog({
        intent,
        ok: true,
        durationMs: Date.now() - startTime,
        productId,
        steps: steps.toResult(),
        shop: auth.session.shop,
      });

      return json<ActionData>({
        ok: true,
        intent,
        productId,
        steps: steps.toResult(),
      });
    } catch (error) {
      if (steps.toResult().length === 0) {
        steps.addFail("publish_only", error);
      }
      const message = error instanceof Error ? error.message : String(error);
      auditLog({
        intent,
        ok: false,
        durationMs: Date.now() - startTime,
        productId,
        steps: steps.toResult(),
        shop: auth.session.shop,
      });
      return json<ActionData>(
        {
          ok: false,
          intent,
          message,
          productId,
          steps: steps.toResult(),
        },
        { status: 400 }
      );
    }
  }

  if (intent === "variants_only") {
    const productId = parseText(formData.get("productId"));
    const maxPax = parseNumber(formData.get("maxPax"));
    if (!productId) {
      return json<ActionData>(
        { ok: false, intent, message: "productId가 필요합니다." },
        { status: 400 }
      );
    }
    if (!Number.isInteger(maxPax) || maxPax < 1) {
      return json<ActionData>(
        { ok: false, intent, message: "max_pax가 유효하지 않습니다." },
        { status: 400 }
      );
    }

    const steps = new StepLogger();
    try {
      let matrix;
      try {
        const pricingTable = buildPricingTable(
          Number.isFinite(maxPax) ? Math.trunc(maxPax) : 0,
          formData
        );
        matrix = toTierPriceMatrix({
          maxPax,
          pricingTable,
        });
        steps.addOk("buildTierMatrix");
      } catch (error) {
        steps.addFail("buildTierMatrix", error);
        throw error;
      }

      try {
        const result = await upsertTierVariants(auth.admin, productId, matrix);
        steps.addOk("upsertTierVariants", {
          created: result.created,
          updated: result.updated,
          deactivated: result.deactivated,
        });
      } catch (error) {
        steps.addFail("upsertTierVariants", error);
        throw error;
      }

      auditLog({
        intent,
        ok: true,
        durationMs: Date.now() - startTime,
        productId,
        steps: steps.toResult(),
        shop: auth.session.shop,
      });

      return json<ActionData>({
        ok: true,
        intent,
        productId,
        steps: steps.toResult(),
      });
    } catch (error) {
      if (steps.toResult().length === 0) {
        steps.addFail("variants_only", error);
      }
      const message = error instanceof Error ? error.message : String(error);
      auditLog({
        intent,
        ok: false,
        durationMs: Date.now() - startTime,
        productId,
        steps: steps.toResult(),
        shop: auth.session.shop,
      });
      return json<ActionData>(
        {
          ok: false,
          intent,
          message,
          productId,
          steps: steps.toResult(),
        },
        { status: 400 }
      );
    }
  }

  if (intent === "save_draft" || intent === "save_and_publish") {
    let upsertInput: UpsertTravelProductInput;
    try {
      upsertInput = await buildUpsertInput(formData);
    } catch (error) {
      const message =
        error instanceof UploadError
          ? error.message
          : error instanceof Error
            ? error.message
            : "파일 처리 중 오류가 발생했습니다.";
      return json<ActionData>(
        { ok: false, intent, message },
        { status: 400 }
      );
    }

    try {
      const result = await upsertTravelProduct(auth.admin, upsertInput, {
        publish: intent === "save_and_publish",
      });

      auditLog({
        intent,
        ok: true,
        durationMs: Date.now() - startTime,
        externalKey: upsertInput.externalKey,
        productId: result.productId,
        steps: result.steps,
        shop: auth.session.shop,
      });

      return json<ActionData>({
        ok: true,
        intent,
        productId: result.productId,
        mode: result.mode,
        steps: result.steps,
        published: result.published,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const steps = (error as Error & { steps?: StepEntry[] }).steps ?? [];
      const productId = (error as Error & { productId?: string }).productId;

      auditLog({
        intent,
        ok: false,
        durationMs: Date.now() - startTime,
        externalKey: upsertInput.externalKey,
        productId,
        steps,
        shop: auth.session.shop,
      });

      return json<ActionData>(
        {
          ok: false,
          intent,
          message,
          productId,
          steps,
        },
        { status: 400 }
      );
    }
  }

  return json<ActionData>(
    { ok: false, intent, message: "지원하지 않는 요청입니다." },
    { status: 400 }
  );
};

export default function ProductUpsertPage() {
  const app = useAppBridge();
  const loaderData = useLoaderData<LoaderData>();
  const { publications } = loaderData;
  const upsertFetcher = useFetcher<ActionData>();
  const loadFetcher = useFetcher<ActionData>();
  const generateFetcher = useFetcher<ActionData>();
  const advancedFetcher = useFetcher<ActionData>();
  const formRef = useRef<HTMLFormElement>(null);

  const defaultPublicationIds = useMemo(() => {
    const online = publications.find((pub) => pub.isOnlineStore);
    return online ? [online.id] : [];
  }, [publications]);

  const [externalKey, setExternalKey] = useState("");
  const [selectedProductTitle, setSelectedProductTitle] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [productId, setProductId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [descriptionHtml, setDescriptionHtml] = useState("");
  const [maxPaxInput, setMaxPaxInput] = useState("1");
  const [pricingRows, setPricingRows] = useState<PriceRow[]>([
    { tier: 1, adult: "", child: "", infant: "" },
  ]);
  const [poolKey, setPoolKey] = useState("");
  const [guideUnitsRequired, setGuideUnitsRequired] = useState("1");
  const [bookingMode, setBookingMode] = useState<BookingMode>("private");
  const [startTimeLabel, setStartTimeLabel] = useState("");
  const [bookingWindowDays, setBookingWindowDays] = useState("0");
  const [operatingWeekdays, setOperatingWeekdays] = useState<Weekday[]>([]);
  const [blackoutInput, setBlackoutInput] = useState("");
  const [blackoutDates, setBlackoutDates] = useState<string[]>([]);
  const [selectedPublicationIds, setSelectedPublicationIds] = useState<string[]>(
    defaultPublicationIds
  );
  const [loadedMedia, setLoadedMedia] = useState<{
    heroMediaId?: string;
    categoryImageFileId?: string;
    galleryFileIds?: string[];
  }>({});
  const [pricingWarnings, setPricingWarnings] = useState<string[]>([]);
  const [loadWarnings, setLoadWarnings] = useState<string[]>([]);
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false);

  const maxPax = Number(maxPaxInput);
  const maxPaxValid = Number.isInteger(maxPax) && maxPax > 0;

  useEffect(() => {
    if (!maxPaxValid) {
      setPricingRows([]);
      return;
    }

    setPricingRows((prev) => {
      const next: PriceRow[] = [];
      for (let tier = 1; tier <= maxPax; tier += 1) {
        const existing = prev.find((row) => row.tier === tier);
        next.push(
          existing || { tier, adult: "", child: "", infant: "" }
        );
      }
      return next;
    });
  }, [maxPax, maxPaxValid]);

  useEffect(() => {
    if (generateFetcher.data?.ok && generateFetcher.data.externalKey) {
      setExternalKey(generateFetcher.data.externalKey);
    }
  }, [generateFetcher.data]);

  useEffect(() => {
    const data = loadFetcher.data;
    const isLoadIntent =
      data?.intent === "load_by_external_key" ||
      data?.intent === "load_by_product_id";
    if (!data?.ok || !isLoadIntent) {
      return;
    }

    const loadResult = data.loadResult;
    if (!loadResult) return;

    setProductId(loadResult.productId);
    setStatus(loadResult.status ?? null);
    setTitle(loadResult.title || "");
    setDescriptionHtml(loadResult.descriptionHtml || "");
    setExternalKey(loadResult.externalKey || externalKey);
    setPoolKey(loadResult.poolKey || "");
    setGuideUnitsRequired(
      loadResult.guideUnitsRequired != null
        ? String(loadResult.guideUnitsRequired)
        : ""
    );
    setBookingMode(loadResult.bookingMode || "private");
    setStartTimeLabel(loadResult.startTimeLabel || "");
    setBookingWindowDays(
      loadResult.bookingWindowDays != null
        ? String(loadResult.bookingWindowDays)
        : ""
    );
    setOperatingWeekdays(loadResult.operatingWeekdays || []);
    setBlackoutDates(loadResult.blackoutDates || []);
    setLoadedMedia({
      heroMediaId: loadResult.heroMediaId,
      categoryImageFileId: loadResult.categoryImageFileId,
      galleryFileIds: loadResult.galleryFileIds,
    });
    setLoadWarnings(loadResult.warnings || []);

    if (data.pricingTable) {
      setMaxPaxInput(String(data.pricingTable.maxPax));
      setPricingRows(
        data.pricingTable.rows.map((row) => ({
          tier: row.tier,
          adult: row.adult != null ? String(row.adult) : "",
          child: row.child != null ? String(row.child) : "",
          infant: row.infant != null ? String(row.infant) : "",
        }))
      );
      const warnings: string[] = [];
      if (data.pricingWarnings?.missingCells?.length) {
        warnings.push(
          `누락 셀: ${data.pricingWarnings.missingCells.slice(0, 10).join(", ")}`
        );
      }
      if (data.pricingWarnings?.zeroPriceCells?.length) {
        warnings.push(
          `0원 셀: ${data.pricingWarnings.zeroPriceCells.slice(0, 10).join(", ")}`
        );
      }
      setPricingWarnings(warnings);
    } else {
      setPricingWarnings([]);
    }
  }, [loadFetcher.data, externalKey]);

  useEffect(() => {
    const data = upsertFetcher.data;
    if (data?.productId) {
      setProductId(data.productId);
    }
  }, [upsertFetcher.data]);

  const submitUpsert = (intent: "save_draft" | "save_and_publish") => {
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    formData.set("intent", intent);
    upsertFetcher.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  const submitAdvanced = (intent: "publish_only" | "variants_only") => {
    if (!formRef.current) return;
    const formData = new FormData(formRef.current);
    formData.set("intent", intent);
    advancedFetcher.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  const loadProduct = () => {
    const formData = new FormData();
    formData.set("intent", "load_by_external_key");
    formData.set("externalKey", externalKey);
    loadFetcher.submit(formData, { method: "post" });
  };

  const pickProduct = async () => {
    setPickerError(null);
    setIsPicking(true);
    try {
      await app.ready;
      const selection = await app.resourcePicker({
        type: "product",
        action: "select",
        multiple: false,
      });
      const picked = selection
        ? Array.isArray(selection)
          ? selection
          : selection.selection
        : [];
      const product = picked[0];
      if (!product) return;

      setProductId(product.id);
      setSelectedProductTitle(product.title || product.id);

      const formData = new FormData();
      formData.set("intent", "load_by_product_id");
      formData.set("productId", product.id);
      loadFetcher.submit(formData, { method: "post" });
    } catch (error) {
      setPickerError(
        error instanceof Error ? error.message : "상품 선택에 실패했습니다."
      );
    } finally {
      setIsPicking(false);
    }
  };

  const generateKey = () => {
    const formData = new FormData();
    formData.set("intent", "generate_external_key");
    generateFetcher.submit(formData, { method: "post" });
  };

  const upsertResult = upsertFetcher.data;
  const advancedResult = advancedFetcher.data;
  const loadError =
    loadFetcher.data && !loadFetcher.data.ok ? loadFetcher.data.message : null;

  const canSubmit =
    externalKey.trim().length > 0 &&
    title.trim().length > 0 &&
    maxPaxValid;

  return (
    <Page>
      <TitleBar title="Travel Product Upsert" />
      <BlockStack gap="500">
        {loaderData.error ? (
          <Banner tone="critical" title="채널 조회 실패">
            <p>{loaderData.error}</p>
          </Banner>
        ) : null}
        {upsertResult && !upsertResult.ok ? (
          <Banner tone="critical" title="저장 실패">
            <p>{upsertResult.message}</p>
          </Banner>
        ) : null}
        {upsertResult && upsertResult.ok ? (
          <Banner tone="success" title="저장 완료">
            <p>
              {upsertResult.mode} 완료 (productId:{" "}
              {upsertResult.productId || "-"})
            </p>
          </Banner>
        ) : null}
        {advancedResult && !advancedResult.ok ? (
          <Banner tone="critical" title="고급 실행 실패">
            <p>{advancedResult.message}</p>
          </Banner>
        ) : null}
        {advancedResult && advancedResult.ok ? (
          <Banner tone="success" title="고급 실행 완료">
            <p>productId: {advancedResult.productId || "-"}</p>
          </Banner>
        ) : null}
        {pickerError ? (
          <Banner tone="critical" title="상품 선택 실패">
            <p>{pickerError}</p>
          </Banner>
        ) : null}
        {loadError ? (
          <Banner tone="critical" title="Load 실패">
            <p>{loadError}</p>
          </Banner>
        ) : null}
        {loadWarnings.length > 0 ? (
          <Banner tone="warning" title="Load 경고">
            <ul>
              {loadWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {pricingWarnings.length > 0 ? (
          <Banner tone="warning" title="가격표 경고">
            <ul>
              {pricingWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              External Key
            </Text>
            <TextField
              label="external_key"
              name="externalKey"
              value={externalKey}
              onChange={setExternalKey}
              autoComplete="off"
            />
            <InlineStack gap="200">
              <Button
                onClick={loadProduct}
                loading={loadFetcher.state !== "idle"}
                disabled={!externalKey.trim()}
              >
                Load
              </Button>
              <Button
                onClick={pickProduct}
                loading={isPicking}
                disabled={isPicking || loadFetcher.state !== "idle"}
              >
                Select Product
              </Button>
              <Button
                onClick={generateKey}
                loading={generateFetcher.state !== "idle"}
              >
                Generate
              </Button>
              <Text as="p" variant="bodySm" tone="subdued">
                Load는 현재 폼을 덮어씁니다.
              </Text>
            </InlineStack>
            {selectedProductTitle ? (
              <Text as="p" variant="bodySm" tone="subdued">
                선택된 상품: {selectedProductTitle}
              </Text>
            ) : null}
            {productId ? (
              <Text as="p" variant="bodySm" tone="subdued">
                productId: {productId} {status ? `(status=${status})` : ""}
              </Text>
            ) : null}
          </BlockStack>
        </Card>

        <form ref={formRef}>
          <input type="hidden" name="intent" value="save_draft" />
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="externalKey" value={externalKey} />

          <BlockStack gap="500">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  기본 정보
                </Text>
                <TextField
                  label="Title"
                  name="title"
                  value={title}
                  onChange={setTitle}
                  autoComplete="off"
                />
                <TextField
                  label="Description HTML"
                  name="descriptionHtml"
                  value={descriptionHtml}
                  onChange={setDescriptionHtml}
                  autoComplete="off"
                  multiline={6}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Media
                </Text>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    heroMedia
                  </Text>
                  <input name="heroMedia" type="file" accept="image/jpeg,image/png" />
                  {loadedMedia.heroMediaId ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      현재 hero media: {loadedMedia.heroMediaId}
                    </Text>
                  ) : null}
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    categoryImage (tour.images1)
                  </Text>
                  <input
                    name="categoryImage"
                    type="file"
                    accept="image/jpeg,image/png"
                  />
                  {loadedMedia.categoryImageFileId ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      현재 categoryImage: {loadedMedia.categoryImageFileId}
                    </Text>
                  ) : null}
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    travelGallery (최대 10장)
                  </Text>
                  <input
                    name="travelGallery"
                    type="file"
                    accept="image/jpeg,image/png"
                    multiple
                  />
                  {loadedMedia.galleryFileIds?.length ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      현재 gallery: {loadedMedia.galleryFileIds.join(", ")}
                    </Text>
                  ) : null}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Metafields
                </Text>
                <TextField
                  label="pool_key"
                  name="poolKey"
                  value={poolKey}
                  onChange={setPoolKey}
                  autoComplete="off"
                />
                <InlineStack gap="200">
                  <TextField
                    label="guide_units_required"
                    name="guideUnitsRequired"
                    value={guideUnitsRequired}
                    onChange={setGuideUnitsRequired}
                    type="number"
                    autoComplete="off"
                  />
                  <TextField
                    label="booking_window_days"
                    name="bookingWindowDays"
                    value={bookingWindowDays}
                    onChange={setBookingWindowDays}
                    type="number"
                    autoComplete="off"
                  />
                </InlineStack>
                <InlineStack gap="200">
                  <Select
                    label="booking_mode"
                    name="bookingMode"
                    options={[
                      { label: "private", value: "private" },
                      { label: "shared", value: "shared" },
                    ]}
                    value={bookingMode}
                    onChange={(value) => setBookingMode(value as BookingMode)}
                  />
                  <TextField
                    label="start_time_label"
                    name="startTimeLabel"
                    value={startTimeLabel}
                    onChange={setStartTimeLabel}
                    autoComplete="off"
                  />
                </InlineStack>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm">
                    operating_weekdays
                  </Text>
                  <InlineStack gap="200" wrap>
                    {WEEKDAYS.map((weekday) => (
                      <Checkbox
                        key={weekday.value}
                        name="operatingWeekdays"
                        label={weekday.label}
                        value={weekday.value}
                        checked={operatingWeekdays.includes(weekday.value)}
                        onChange={(checked) => {
                          setOperatingWeekdays((prev) => {
                            if (checked) {
                              return [...prev, weekday.value];
                            }
                            return prev.filter((day) => day !== weekday.value);
                          });
                        }}
                      />
                    ))}
                  </InlineStack>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm">
                    blackout_dates
                  </Text>
                  <InlineStack gap="200">
                    <TextField
                      label="YYYY-MM-DD"
                      value={blackoutInput}
                      onChange={setBlackoutInput}
                      autoComplete="off"
                    />
                    <Button
                      onClick={() => {
                        const next = blackoutInput.trim();
                        if (!next) return;
                        if (blackoutDates.includes(next)) return;
                        setBlackoutDates((prev) => [...prev, next]);
                        setBlackoutInput("");
                      }}
                    >
                      Add
                    </Button>
                  </InlineStack>
                  <InlineStack gap="200" wrap>
                    {blackoutDates.map((date) => (
                      <Button
                        key={date}
                        size="micro"
                        tone="critical"
                        onClick={() =>
                          setBlackoutDates((prev) =>
                            prev.filter((value) => value !== date)
                          )
                        }
                      >
                        {date}
                      </Button>
                    ))}
                  </InlineStack>
                  {blackoutDates.map((date) => (
                    <input
                      key={`blackout-${date}`}
                      type="hidden"
                      name="blackoutDates"
                      value={date}
                    />
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Pricing Table
                </Text>
                <TextField
                  label="max_pax"
                  name="maxPax"
                  value={maxPaxInput}
                  onChange={setMaxPaxInput}
                  type="number"
                  autoComplete="off"
                />
                {pricingRows.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric"]}
                    headings={["Pax Tier", "Adult", "Child", "Infant"]}
                    rows={pricingRows.map((row) => [
                      row.tier,
                      <TextField
                        key={`adult-${row.tier}`}
                        label={`Adult tier ${row.tier}`}
                        labelHidden
                        name={`price_${row.tier}_adult`}
                        value={row.adult}
                        onChange={(value) =>
                          setPricingRows((prev) =>
                            prev.map((item) =>
                              item.tier === row.tier
                                ? { ...item, adult: value }
                                : item
                            )
                          )
                        }
                        type="number"
                        autoComplete="off"
                      />,
                      <TextField
                        key={`child-${row.tier}`}
                        label={`Child tier ${row.tier}`}
                        labelHidden
                        name={`price_${row.tier}_child`}
                        value={row.child}
                        onChange={(value) =>
                          setPricingRows((prev) =>
                            prev.map((item) =>
                              item.tier === row.tier
                                ? { ...item, child: value }
                                : item
                            )
                          )
                        }
                        type="number"
                        autoComplete="off"
                      />,
                      <TextField
                        key={`infant-${row.tier}`}
                        label={`Infant tier ${row.tier}`}
                        labelHidden
                        name={`price_${row.tier}_infant`}
                        value={row.infant}
                        onChange={(value) =>
                          setPricingRows((prev) =>
                            prev.map((item) =>
                              item.tier === row.tier
                                ? { ...item, infant: value }
                                : item
                            )
                          )
                        }
                        type="number"
                        autoComplete="off"
                      />,
                    ])}
                  />
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    max_pax 값을 입력하면 가격표가 생성됩니다.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Publish Channels
                </Text>
                <InlineStack gap="200" wrap>
                  {publications.map((pub) => (
                    <Checkbox
                      key={pub.id}
                      name="publicationIds"
                      label={pub.name}
                      value={pub.id}
                      checked={selectedPublicationIds.includes(pub.id)}
                      onChange={(checked) => {
                        setSelectedPublicationIds((prev) => {
                          if (checked) return [...prev, pub.id];
                          return prev.filter((id) => id !== pub.id);
                        });
                      }}
                    />
                  ))}
                </InlineStack>
                {selectedPublicationIds.length === 0 ? (
                  <Text as="p" tone="critical">게시하려면 판매 채널을 하나 이상 선택해 주세요.</Text>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200">
                  <Button
                    onClick={() => submitUpsert("save_draft")}
                    disabled={!canSubmit}
                    loading={upsertFetcher.state !== "idle"}
                  >
                    {productId ? "Save Changes" : "Save Draft"}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => submitUpsert("save_and_publish")}
                    disabled={!canSubmit || selectedPublicationIds.length === 0}
                    loading={upsertFetcher.state !== "idle"}
                  >
                    Save & Publish
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Save Changes는 기존 판매 상태와 게시 채널을 유지합니다. 새 상품은 초안으로 저장됩니다.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </form>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Advanced Actions
            </Text>
            <InlineStack gap="200">
              <Button
                onClick={() => submitAdvanced("publish_only")}
                disabled={!productId || !maxPaxValid || selectedPublicationIds.length === 0}
                loading={advancedFetcher.state !== "idle"}
              >
                Publish Only
              </Button>
              <Button
                onClick={() => submitAdvanced("variants_only")}
                disabled={!productId || !maxPaxValid}
                loading={advancedFetcher.state !== "idle"}
              >
                Variants Only
              </Button>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              productId가 없으면 실행할 수 없습니다.
            </Text>
          </BlockStack>
        </Card>

        {upsertResult?.steps?.length ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Upsert Steps
              </Text>
              <BlockStack gap="200">
                {upsertResult.steps.map((step) => (
                  <InlineStack key={step.step} gap="200" align="space-between">
                    <Text as="span" variant="bodySm">
                      {step.step}
                    </Text>
                    <Badge tone={step.ok ? "success" : "critical"}>
                      {step.ok ? "OK" : "FAIL"}
                    </Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        ) : null}

        {advancedResult?.steps?.length ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Advanced Steps
              </Text>
              <BlockStack gap="200">
                {advancedResult.steps.map((step) => (
                  <InlineStack key={step.step} gap="200" align="space-between">
                    <Text as="span" variant="bodySm">
                      {step.step}
                    </Text>
                    <Badge tone={step.ok ? "success" : "critical"}>
                      {step.ok ? "OK" : "FAIL"}
                    </Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        ) : null}

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between">
              <Text as="h2" variant="headingMd">
                Troubleshooting
              </Text>
              <Button
                onClick={() => setTroubleshootingOpen((prev) => !prev)}
                variant="plain"
              >
                {troubleshootingOpen ? "Hide" : "Show"}
              </Button>
            </InlineStack>
            <Collapsible open={troubleshootingOpen}>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm">
                  업로드 실패 → 파일 포맷/크기 확인
                </Text>
                <Text as="p" variant="bodySm">
                  metafields 오류 → 타입/포맷 확인
                </Text>
                <Text as="p" variant="bodySm">
                  variants 불일치 → Variants Only 실행
                </Text>
                <Text as="p" variant="bodySm">
                  publish 실패 → Publish Only 실행
                </Text>
                <Text as="p" variant="bodySm">
                  external_key 중복 → 운영 확인
                </Text>
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
