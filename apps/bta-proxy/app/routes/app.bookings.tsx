import { useEffect, useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { redirect } from "react-router";
import { Link, Outlet, useFetcher, useLoaderData, useParams } from "react-router";
import {
  BlockStack,
  Badge,
  Box,
  Button,
  Card,
  InlineStack,
  Page,
  Text,
  Banner,
  TextField,
  Modal,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  listAdminCalendar,
  type CalendarDayItem,
  type CalendarBookingSummary,
} from "~/domains/bookings/adminCalendarService";
import { sliceBookings } from "~/domains/bookings/calendarUiUtils";
import { getLastRebuildRun, type RebuildRunMeta } from "~/domains/bookings/rebuildMetaStore";
import { getRedisBookingClient } from "~/domains/bookings/bookingStore";
import { getEnv } from "~/lib/env";
import { getBookingStatusDisplay, normalizeBookingStatus } from "~/domains/bookings/bookingStatus";
import { normalizeProductIdForBookings } from "~/domains/catalog/shopifyProductId";

type LoaderData = {
  month: string;
  from: string;
  to: string;
  shop: string;
  productId?: string;
  items: CalendarDayItem[];
  blackouts: string[];
  summary?: {
    bookingsCount: number;
    missingRecordCount: number;
    parseErrorCount: number;
  };
  lastRebuild?: RebuildRunMeta | null;
  rebuildDefaults: {
    ordersFrom: string;
    ordersTo: string;
    mode: "upsert" | "replace";
  };
  error?: string;
};

const MAX_BOOKINGS_PER_DAY = 3;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatMonth(year: number, month: number): string {
  return `${year}-${pad2(month)}`;
}

function parseMonth(value: string | null): { year: number; month: number } | null {
  if (!value) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

function getMonthRange(
  year: number,
  month: number,
): {
  from: string;
  to: string;
  daysInMonth: number;
  firstWeekday: number;
} {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  return {
    from: `${year}-${pad2(month)}-01`,
    to: `${year}-${pad2(month)}-${pad2(daysInMonth)}`,
    daysInMonth,
    firstWeekday,
  };
}

function shiftMonth(
  year: number,
  month: number,
  delta: number,
): {
  year: number;
  month: number;
} {
  let nextYear = year;
  let nextMonth = month + delta;
  while (nextMonth < 1) {
    nextMonth += 12;
    nextYear -= 1;
  }
  while (nextMonth > 12) {
    nextMonth -= 12;
    nextYear += 1;
  }
  return { year: nextYear, month: nextMonth };
}

function formatTravelers(travelers?: CalendarBookingSummary["travelers"]): string {
  if (!travelers) {
    return "Travelers: -";
  }
  const total = travelers.adult + travelers.child + travelers.infant;
  return `Travelers: ${total}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const url = new URL(request.url);
  const bookingIdParam = url.searchParams.get("bookingId");
  if (bookingIdParam) {
    const cleanedParams = new URLSearchParams(url.searchParams);
    cleanedParams.delete("bookingId");
    const query = cleanedParams.toString();
    const redirectTo = query
      ? `/app/bookings/${bookingIdParam}?${query}`
      : `/app/bookings/${bookingIdParam}`;
    throw redirect(redirectTo);
  }
  const monthParam = parseMonth(url.searchParams.get("month"));
  const productId = url.searchParams.get("productId") || undefined;
  const now = new Date();
  const year = monthParam?.year ?? now.getFullYear();
  const month = monthParam?.month ?? now.getMonth() + 1;
  const range = getMonthRange(year, month);
  const env = getEnv();
  const offsetDays = env.REBUILD_AUTO_TO_OFFSET_DAYS ?? 1;
  const lookbackDays = env.REBUILD_AUTO_DAYS ?? 30;
  const ordersToDate = new Date(now);
  ordersToDate.setDate(ordersToDate.getDate() - offsetDays);
  const ordersFromDate = new Date(ordersToDate);
  ordersFromDate.setDate(ordersFromDate.getDate() - lookbackDays);
  const ordersFrom = ordersFromDate.toISOString().split("T")[0];
  const ordersTo = ordersToDate.toISOString().split("T")[0];
  const rebuildMode = env.REBUILD_AUTO_MODE ?? "upsert";

  let result: {
    items: CalendarDayItem[];
    blackouts: string[];
    summary?: LoaderData["summary"];
  } = {
    items: [],
    blackouts: [],
  };
  let error: string | undefined;
  let lastRebuild: RebuildRunMeta | null = null;
  try {
    const payload = await listAdminCalendar({
      admin: auth.admin,
      shop: auth.session.shop,
      from: range.from,
      to: range.to,
      ...(productId ? { productId } : {}),
    });
    result = {
      items: payload.items,
      blackouts: payload.blackouts,
      summary: payload.summary,
    };

    const redisClient = getRedisBookingClient();
    if (redisClient) {
      lastRebuild = await getLastRebuildRun(redisClient, auth.session.shop);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error = message.includes("Access denied for metaobjects")
      ? "Metaobject 권한이 없습니다. 앱 권한에 read_metaobjects/write_metaobjects가 포함되어 있는지 확인하세요."
      : message === "REDIS_BOOKING_STORE_REQUIRED"
        ? "Redis Booking Store가 필요합니다. 환경변수를 확인하세요."
        : "캘린더 데이터를 불러오지 못했습니다.";
  }

  return json<LoaderData>({
    month: formatMonth(year, month),
    from: range.from,
    to: range.to,
    shop: auth.session.shop,
    ...(productId ? { productId } : {}),
    items: result.items,
    blackouts: result.blackouts,
    ...(result.summary ? { summary: result.summary } : {}),
    ...(lastRebuild ? { lastRebuild } : {}),
    rebuildDefaults: {
      ordersFrom,
      ordersTo,
      mode: rebuildMode,
    },
    ...(error ? { error } : {}),
  });
};

export default function AdminBookingsPage() {
  const loaderData = useLoaderData<LoaderData>();
  const app = useAppBridge();
  const listFetcher = useFetcher<any>();
  const rebuildFetcher = useFetcher<any>();
  const params = useParams();
  const isDetail = Boolean(params.bookingId);
  const [clientRedirected, setClientRedirected] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const url = new URL(window.location.href);
    const bookingIdParam = url.searchParams.get("bookingId");
    if (bookingIdParam && !clientRedirected) {
      const cleanedParams = new URLSearchParams(url.searchParams);
      cleanedParams.delete("bookingId");
      const query = cleanedParams.toString();
      const redirectTo = query
        ? `/app/bookings/${bookingIdParam}?${query}`
        : `/app/bookings/${bookingIdParam}`;
      setClientRedirected(true);
      window.location.replace(redirectTo);
    }
  }, [clientRedirected]);

  const initialMonth = parseMonth(loaderData.month) || {
    year: new Date().getFullYear(),
    month: new Date().getMonth() + 1,
  };

  const [currentYear, setCurrentYear] = useState(initialMonth.year);
  const [currentMonth, setCurrentMonth] = useState(initialMonth.month);
  const [items, setItems] = useState<CalendarDayItem[]>(loaderData.items);
  const [blackoutDates, setBlackoutDates] = useState<string[]>(loaderData.blackouts);
  const [productIdFilter, setProductIdFilter] = useState(
    normalizeProductIdForBookings(loaderData.productId || ""),
  );
  const [selectedProductTitle, setSelectedProductTitle] = useState("");
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [isPickingProduct, setIsPickingProduct] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(loaderData.error || null);
  const [summary, setSummary] = useState(loaderData.summary || null);
  const [lastRebuild, setLastRebuild] = useState<RebuildRunMeta | null>(
    loaderData.lastRebuild || null,
  );
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [rebuildResult, setRebuildResult] = useState<any | null>(null);
  const [isRebuildModalOpen, setIsRebuildModalOpen] = useState(false);
  const rebuildDefaults = loaderData.rebuildDefaults;
  const shop = loaderData.shop;
  const [isDayModalOpen, setIsDayModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [panelProductFilter, setPanelProductFilter] = useState("");

  const range = getMonthRange(currentYear, currentMonth);
  const blackoutSet = useMemo(() => new Set(blackoutDates), [blackoutDates]);
  const bookingsByDate = useMemo(() => {
    const map = new Map<string, CalendarBookingSummary[]>();
    for (const item of items) {
      map.set(item.travelDate, item.bookings);
    }
    return map;
  }, [items]);
  const weekLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const selectedBookings = useMemo(() => {
    if (!selectedDate) {
      return [];
    }
    return bookingsByDate.get(selectedDate) || [];
  }, [selectedDate, bookingsByDate]);
  const filteredBookings = useMemo(() => {
    if (!panelProductFilter.trim()) {
      return selectedBookings;
    }
    const needle = panelProductFilter.trim();
    return selectedBookings.filter((booking) => booking.productId.includes(needle));
  }, [panelProductFilter, selectedBookings]);
  const selectedIsBlackout = selectedDate ? blackoutSet.has(selectedDate) : false;

  useEffect(() => {
    if (isDetail) {
      return;
    }
    if (!listFetcher.data || !("ok" in listFetcher.data)) {
      return;
    }
    const payload = listFetcher.data as any;
    if (!payload.ok) {
      setErrorMessage(payload.error?.message || "Failed to load calendar.");
      return;
    }
    const nextItems = payload.data?.items || [];
    const nextBlackouts = payload.data?.blackouts || [];
    const nextSummary = payload.data?.summary || null;
    setItems(nextItems);
    setBlackoutDates(nextBlackouts);
    setSummary(nextSummary);
    if (isDayModalOpen) {
      setIsDayModalOpen(false);
      setSelectedDate(null);
      setPanelProductFilter("");
    }
  }, [listFetcher.data, isDetail, isDayModalOpen]);

  useEffect(() => {
    if (!rebuildFetcher.data) {
      return;
    }
    if (rebuildFetcher.data.ok) {
      const now = new Date().toISOString();
      setRebuildError(null);
      setRebuildResult(rebuildFetcher.data);
      setLastRebuild({
        runId: rebuildFetcher.data.meta?.rebuildRunId || "-",
        startedAt: now,
        finishedAt: now,
        mode: rebuildDefaults.mode,
        ordersFrom: rebuildDefaults.ordersFrom,
        ordersTo: rebuildDefaults.ordersTo,
        result: rebuildFetcher.data.data,
      });
    } else {
      setRebuildResult(null);
      setRebuildError(
        rebuildFetcher.data.error?.message || rebuildFetcher.data.error || "리빌드에 실패했습니다.",
      );
    }
  }, [rebuildFetcher.data]);

  const calendarCells: Array<{ date: string | null; day: number | null }> = [];
  for (let i = 0; i < range.firstWeekday; i += 1) {
    calendarCells.push({ date: null, day: null });
  }
  for (let day = 1; day <= range.daysInMonth; day += 1) {
    calendarCells.push({
      date: `${currentYear}-${pad2(currentMonth)}-${pad2(day)}`,
      day,
    });
  }
  while (calendarCells.length % 7 !== 0) {
    calendarCells.push({ date: null, day: null });
  }

  const handleMonthChange = (delta: number) => {
    if (isDetail) {
      return;
    }
    const next = shiftMonth(currentYear, currentMonth, delta);
    setCurrentYear(next.year);
    setCurrentMonth(next.month);
    setErrorMessage(null);
    setIsDayModalOpen(false);
    setSelectedDate(null);
    setPanelProductFilter("");
    const nextRange = getMonthRange(next.year, next.month);
    const productParam = productIdFilter ? `&productId=${encodeURIComponent(productIdFilter)}` : "";
    listFetcher.load(
      `/proxy/internal/admin/calendar?from=${nextRange.from}&to=${nextRange.to}${productParam}`,
    );
  };

  const handleApplyFilter = () => {
    if (isDetail) {
      return;
    }
    setErrorMessage(null);
    setIsDayModalOpen(false);
    setSelectedDate(null);
    setPanelProductFilter("");
    const productParam = productIdFilter ? `&productId=${encodeURIComponent(productIdFilter)}` : "";
    listFetcher.load(
      `/proxy/internal/admin/calendar?from=${range.from}&to=${range.to}${productParam}`,
    );
  };

  const handlePickProduct = async () => {
    if (isDetail) {
      return;
    }
    setPickerError(null);
    setIsPickingProduct(true);
    try {
      await app.ready;
      const selection = await app.resourcePicker({
        type: "product",
        action: "select",
        multiple: false,
      });
      const picked = selection ? (Array.isArray(selection) ? selection : selection.selection) : [];
      const product = picked[0];
      if (!product) {
        return;
      }
      const normalizedProductId = normalizeProductIdForBookings(product.id);
      setProductIdFilter(normalizedProductId);
      setSelectedProductTitle(product.title || normalizedProductId);
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : "상품 선택에 실패했습니다.");
    } finally {
      setIsPickingProduct(false);
    }
  };

  const handleClearProductFilter = () => {
    setProductIdFilter("");
    setSelectedProductTitle("");
    setPickerError(null);
  };

  const handleOpenDayModal = (date: string) => {
    setSelectedDate(date);
    setPanelProductFilter("");
    setIsDayModalOpen(true);
  };

  const handleCloseDayModal = () => {
    setIsDayModalOpen(false);
    setSelectedDate(null);
    setPanelProductFilter("");
  };

  const renderStatusBadge = (status?: string) => {
    const display = getBookingStatusDisplay(normalizeBookingStatus(status));
    return <Badge tone={display.tone}>{display.label}</Badge>;
  };

  if (isDetail) {
    return <Outlet />;
  }

  return (
    <Page>
      <TitleBar title="Bookings Calendar" />
      <BlockStack gap="500">
        {errorMessage ? (
          <Banner tone="critical" title="요청 실패">
            <p>{errorMessage}</p>
          </Banner>
        ) : null}
        {summary && (summary.missingRecordCount > 0 || summary.parseErrorCount > 0) ? (
          <Banner tone="warning" title="데이터 불일치 감지">
            <p>
              누락={summary.missingRecordCount}, 파싱 오류={summary.parseErrorCount}
            </p>
          </Banner>
        ) : null}
        {rebuildError ? (
          <Banner tone="critical" title="리빌드 실패">
            <p>{rebuildError}</p>
          </Banner>
        ) : null}
        {pickerError ? (
          <Banner tone="critical" title="상품 선택 실패" onDismiss={() => setPickerError(null)}>
            <p>{pickerError}</p>
          </Banner>
        ) : null}
        {rebuildResult ? (
          <Banner tone="success" title="리빌드 완료">
            <p>
              주문={rebuildResult.data?.scannedOrders ?? "-"}, 반영=
              {rebuildResult.data?.upsertedBookings ?? "-"}, 삭제=
              {rebuildResult.data?.deletedBookings ?? "-"}
            </p>
          </Banner>
        ) : null}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                시스템 상태
              </Text>
              <Button
                variant="primary"
                onClick={() => setIsRebuildModalOpen(true)}
                loading={rebuildFetcher.state !== "idle"}
              >
                리빌드 실행
              </Button>
            </InlineStack>
            <Text as="p" variant="bodySm">
              최근 리빌드: {lastRebuild?.finishedAt || "-"}
            </Text>
            <Text as="p" variant="bodySm">
              실행 ID: {lastRebuild?.runId || "-"}
            </Text>
            {lastRebuild?.result ? (
              <Text as="p" variant="bodySm">
                반영: {lastRebuild.result.upsertedBookings}, 삭제:{" "}
                {lastRebuild.result.deletedBookings}
              </Text>
            ) : null}
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between">
              <InlineStack gap="200" align="center">
                <Button onClick={() => handleMonthChange(-1)}>&lt;</Button>
                <Text as="h2" variant="headingMd">
                  {formatMonth(currentYear, currentMonth)}
                </Text>
                <Button onClick={() => handleMonthChange(1)}>&gt;</Button>
              </InlineStack>
              <Text as="p" variant="bodyMd">
                Product ID 없이 조회하면 전역 블랙아웃만 표시됩니다.
              </Text>
            </InlineStack>
            <InlineStack gap="300" align="center" blockAlign="end">
              <BlockStack gap="100">
                <Text as="span" variant="bodySm" tone="subdued">
                  Product filter
                </Text>
                <Text as="p" variant="bodyMd">
                  {productIdFilter
                    ? selectedProductTitle || `Product ID ${productIdFilter}`
                    : "No product selected"}
                </Text>
                {productIdFilter ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    ID: {productIdFilter}
                  </Text>
                ) : null}
              </BlockStack>
              <Button onClick={handlePickProduct} loading={isPickingProduct}>
                Select product
              </Button>
              <Button onClick={handleClearProductFilter} disabled={!productIdFilter}>
                Clear
              </Button>
              <Button onClick={handleApplyFilter}>Apply</Button>
            </InlineStack>
            <Box>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
                  gap: "6px",
                }}
              >
                {weekLabels.map((label) => (
                  <div key={label} style={{ textAlign: "center", fontWeight: 600 }}>
                    {label}
                  </div>
                ))}
                {calendarCells.map((cell, index) => {
                  if (!cell.date) {
                    return (
                      <div
                        key={`empty-${index}`}
                        style={{
                          minHeight: "110px",
                          border: "1px solid #e1e3e5",
                          borderRadius: "8px",
                          background: "#fafbfb",
                        }}
                      />
                    );
                  }
                  const bookings = bookingsByDate.get(cell.date) || [];
                  const { visible, hiddenCount } = sliceBookings(bookings, MAX_BOOKINGS_PER_DAY);
                  const isBlackout = blackoutSet.has(cell.date);
                  return (
                    <div
                      key={cell.date}
                      onClick={() => handleOpenDayModal(cell.date || "")}
                      style={{
                        minHeight: "110px",
                        border: "1px solid #e1e3e5",
                        borderRadius: "8px",
                        padding: "6px",
                        background: isBlackout ? "#FFF4F4" : "#ffffff",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                        cursor: "pointer",
                      }}
                    >
                      <InlineStack align="space-between">
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          {cell.day}
                        </Text>
                        {isBlackout ? (
                          <Text as="span" variant="bodySm" tone="critical">
                            blackout
                          </Text>
                        ) : null}
                      </InlineStack>
                      {bookings.length > 0 ? (
                        <BlockStack gap="100">
                          {visible.map((booking) => (
                            <Box key={booking.bookingId}>
                              <Text as="p" variant="bodySm">
                                <InlineStack gap="200" align="space-between">
                                  <Link
                                    to={`/app/bookings/${booking.bookingId}`}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    {booking.productTitle || booking.productId}
                                  </Link>
                                  {renderStatusBadge(booking.status)}
                                </InlineStack>
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {formatTravelers(booking.travelers)}
                              </Text>
                            </Box>
                          ))}
                          {hiddenCount > 0 ? (
                            <Button
                              variant="plain"
                              onClick={() => handleOpenDayModal(cell.date || "")}
                            >
                              +{hiddenCount.toString()} more
                            </Button>
                          ) : null}
                        </BlockStack>
                      ) : (
                        <Text as="p" variant="bodySm" tone="subdued">
                          -
                        </Text>
                      )}
                    </div>
                  );
                })}
              </div>
            </Box>
          </BlockStack>
        </Card>
      </BlockStack>
      <Modal
        open={isDayModalOpen}
        onClose={handleCloseDayModal}
        title={selectedDate ? `Bookings on ${selectedDate}` : "Bookings"}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {selectedIsBlackout ? (
              <Text as="p" variant="bodySm" tone="critical">
                blackout
              </Text>
            ) : null}
            <TextField
              label="Filter by productId"
              value={panelProductFilter}
              onChange={(value) => setPanelProductFilter(value)}
              autoComplete="off"
            />
            {filteredBookings.length > 0 ? (
              <BlockStack gap="200">
                {filteredBookings.map((booking) => (
                  <Card key={booking.bookingId}>
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd">
                        <InlineStack gap="200" align="space-between">
                          <Link to={`/app/bookings/${booking.bookingId}`}>
                            {booking.productTitle || booking.productId}
                          </Link>
                          {renderStatusBadge(booking.status)}
                        </InlineStack>
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {formatTravelers(booking.travelers)}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        Order: {booking.orderId}
                      </Text>
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                해당 날짜 예약이 없습니다.
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
      <Modal
        open={isRebuildModalOpen}
        onClose={() => setIsRebuildModalOpen(false)}
        title="리빌드 실행"
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodySm">
              리빌드는 Redis confirmed ledger를 재생성합니다. 실행 중에는 락이 걸릴 수 있습니다.
            </Text>
            <InlineStack gap="200">
              <Button onClick={() => setIsRebuildModalOpen(false)}>취소</Button>
              <Button
                variant="primary"
                onClick={() => {
                  const payload = {
                    shop,
                    ordersFrom: rebuildDefaults.ordersFrom,
                    ordersTo: rebuildDefaults.ordersTo,
                    mode: rebuildDefaults.mode,
                    dryRun: false,
                  };
                  const actionUrl = `/proxy/internal/rebuild?shop=${encodeURIComponent(shop)}`;
                  rebuildFetcher.submit(JSON.stringify(payload), {
                    method: "post",
                    action: actionUrl,
                    encType: "application/json",
                  });
                  setIsRebuildModalOpen(false);
                }}
                loading={rebuildFetcher.state !== "idle"}
              >
                실행
              </Button>
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
