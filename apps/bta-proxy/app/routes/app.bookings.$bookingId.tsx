import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useState } from "react";
import {
  BlockStack,
  Card,
  Page,
  Text,
  Banner,
  FormLayout,
  InlineStack,
  Button,
  Spinner,
  Badge,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { completeBookingTour, getBookingCompletion } from "~/lib/bookingCompletionService";
import {
  getBookingDetailData,
  BookingDetailError,
  type BookingDetailData,
} from "~/lib/bookingDetailService";
import {
  rescheduleBookingTravelDate,
  type RescheduleResult,
} from "~/lib/bookingRescheduleService";
import {
  getBookingStatusDisplay,
  normalizeBookingStatus,
} from "~/lib/bookingStatus";

type LoaderData = {
  booking?: BookingDetailData["booking"];
  order?: BookingDetailData["order"];
  orderUrl?: BookingDetailData["orderUrl"];
  bookingExtras?: BookingDetailData["bookingExtras"];
  enableReschedule?: boolean;
  tourCompleted?: boolean;
  canCompleteTour?: boolean;
  completionError?: string;
  error?: string;
};

type ActionData =
  | { ok: true; successMessage: string; warningMessage?: string }
  | {
      ok: false;
      errorMessage: string;
      errorCode?: string;
      fieldErrors?: { newTravelDate?: string };
    };

function formatTravelers(travelers?: {
  adult: number;
  child: number;
  infant: number;
}): string {
  if (!travelers) {
    return "Adult x -, Children x -, Infant x -";
  }
  return `Adult x ${travelers.adult}, Children x ${travelers.child}, Infant x ${travelers.infant}`;
}

function formatTravelersTotal(travelers?: {
  adult: number;
  child: number;
  infant: number;
}): string {
  if (!travelers) {
    return "-";
  }
  return String(travelers.adult + travelers.child + travelers.infant);
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  try {
    const detail = await getBookingDetailData({
      shop: auth.session.shop,
      admin: auth.admin,
      bookingId: params.bookingId,
    });
    const enableReschedule = process.env.ENABLE_ADMIN_RESCHEDULE !== "false";
    let completion;
    let completionError: string | undefined;
    try {
      completion = await getBookingCompletion(auth.admin, detail.booking);
    } catch {
      completionError = "투어 완료 상태를 확인하지 못했습니다. 새로고침 후 다시 확인해 주세요.";
    }
    return json<LoaderData>({
      booking: detail.booking,
      order: detail.order,
      orderUrl: detail.orderUrl,
      bookingExtras: detail.bookingExtras,
      enableReschedule: enableReschedule && !completion?.completed && !completionError,
      tourCompleted: completion?.completed ?? false,
      canCompleteTour: Boolean(completion?.active && !completion.completed),
      completionError,
    });
  } catch (error) {
    if (error instanceof BookingDetailError) {
      return json<LoaderData>(
        { error: error.message },
        { status: error.status },
      );
    }
    return json<LoaderData>(
      { error: "예약 정보를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "complete_tour") {
    try {
      const detail = await getBookingDetailData({ shop: auth.session.shop, admin: auth.admin, bookingId: params.bookingId });
      await completeBookingTour(auth.admin, detail.booking);
      return json<ActionData>({ ok: true, successMessage: "투어 완료 처리되었습니다. 고객의 예약 상태가 TOUR COMPLETED로 변경되고 리뷰 작성이 열립니다." });
    } catch (error) {
      return json<ActionData>({ ok: false, errorMessage: error instanceof Error ? error.message : "투어 완료 처리에 실패했습니다." }, { status: 400 });
    }
  }

  if (intent !== "reschedule_travel_date") {
    return null;
  }

  const newTravelDate = String(formData.get("newTravelDate") || "");
  const fieldErrors: { newTravelDate?: string } = {};

  if (!newTravelDate) {
    fieldErrors.newTravelDate = "새로운 여행일을 입력해 주세요.";
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(newTravelDate)) {
    fieldErrors.newTravelDate = "날짜 형식이 올바르지 않습니다.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return json<ActionData>({
      ok: false,
      errorMessage: "입력값을 확인해 주세요.",
      fieldErrors,
      errorCode: "INVALID_DATE_FORMAT",
    });
  }

  let bookingTravelDate = "";
  try {
    const detail = await getBookingDetailData({
      shop: auth.session.shop,
      admin: auth.admin,
      bookingId: params.bookingId,
    });
    bookingTravelDate = detail.booking.travelDate;
    const completion = await getBookingCompletion(auth.admin, detail.booking);
    if (completion.completed) return json<ActionData>({ ok: false, errorMessage: "완료된 투어의 일정은 변경할 수 없습니다." }, { status: 409 });
  } catch (error) {
    const message =
      error instanceof BookingDetailError
        ? error.message
        : "예약 정보를 불러오지 못했습니다.";
    return json<ActionData>({
      ok: false,
      errorMessage: message,
      errorCode: "BOOKING_NOT_FOUND",
    });
  }

  if (newTravelDate === bookingTravelDate) {
    return json<ActionData>({
      ok: false,
      errorMessage: "현재 여행일과 동일합니다.",
      fieldErrors: { newTravelDate: "기존 여행일과 동일합니다." },
      errorCode: "SAME_DATE",
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  if (newTravelDate < today) {
    return json<ActionData>({
      ok: false,
      errorMessage: "과거 날짜로는 변경할 수 없습니다.",
      fieldErrors: { newTravelDate: "과거 날짜는 선택할 수 없습니다." },
      errorCode: "DATE_IN_PAST",
    });
  }

  let result: RescheduleResult;
  try {
    result = await rescheduleBookingTravelDate({
      shop: auth.session.shop,
      bookingId: params.bookingId || "",
      newTravelDate,
      nowIso: new Date().toISOString(),
    });
  } catch (error) {
    return json<ActionData>({
      ok: false,
      errorMessage: "일정 변경 처리 중 오류가 발생했습니다.",
      errorCode: "INTERNAL_ERROR",
    });
  }

  if (!result.ok) {
    const messageMap: Record<string, string> = {
      BOOKING_NOT_FOUND: "예약 정보를 찾을 수 없습니다.",
      INVALID_DATE_FORMAT: "날짜 형식이 올바르지 않습니다.",
      SAME_DATE: "현재 여행일과 동일합니다.",
      DATE_IN_PAST: "과거 날짜로는 변경할 수 없습니다.",
      ELIGIBILITY_CONFLICT: "선택한 날짜에 예약이 불가합니다.",
      INTERNAL_ERROR: "일정 변경 처리 중 오류가 발생했습니다.",
    };
    const errorMessage = messageMap[result.code] || result.message;
    return json<ActionData>({
      ok: false,
      errorMessage,
      errorCode: result.code,
      fieldErrors:
        result.field === "newTravelDate"
          ? { newTravelDate: result.message }
          : undefined,
    });
  }

  return json<ActionData>({
    ok: true,
    successMessage: "여행 일정이 변경되었습니다.",
    warningMessage: (result as any).warningMessage,
  });
};

export default function BookingDetailPage() {
  const data = useLoaderData<LoaderData>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const [newTravelDate, setNewTravelDate] = useState("");
  const rescheduleEnabled = data.enableReschedule ?? true;

  if (data.error || !data.booking) {
    return (
      <Page>
        <TitleBar title="Booking Detail" />
        <Banner
          tone="critical"
          title="Load failed"
          action={{
            content: "Retry",
            onAction: () => window.location.reload(),
          }}
        >
          <p>{data.error || "예약 정보를 불러오지 못했습니다."}</p>
        </Banner>
      </Page>
    );
  }

  const booking = data.booking;
  const order = data.order;
  const statusDisplay = getBookingStatusDisplay(
    normalizeBookingStatus(booking.status),
  );

  const orderLink = data.orderUrl;
  const pdfLink = `/app/bookings/${booking.bookingId}/pdf`;
  const extras = data.bookingExtras;

  const handleOpenOrder = () => {
    if (!orderLink) return;
    window.open(orderLink, "_blank", "noopener,noreferrer");
  };

  // PDF 다운로드 핸들러 - fetch를 사용하여 현재 세션으로 PDF 다운로드
  const handlePdfDownload = async () => {
    try {
      const response = await fetch(pdfLink);
      if (!response.ok) {
        throw new Error(`PDF 다운로드 실패: ${response.status}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `booking-${booking.travelDate}-${booking.productId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("PDF 다운로드 실패:", error);
      alert("PDF 다운로드에 실패했습니다. 다시 시도해주세요.");
    }
  };
  const pickupLocation = extras?.pickupLocation || "-";
  const dietaryRestrictions = extras?.dietaryRestrictions || "-";
  const reservationContactName = extras?.reservationContactName || "-";
  const reservationContactPhone = extras?.reservationContactPhone || "-";
  const productLabel =
    booking.productTitle || order?.title || booking.productId;

  return (
    <Page>
      <TitleBar title={`Booking ${booking.travelDate}`} />
      <BlockStack gap="500">
        {isLoading ? (
          <InlineStack align="center" blockAlign="center">
            <Spinner size="small" />
            <Text as="span" variant="bodySm">
              Loading...
            </Text>
          </InlineStack>
        ) : null}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">
                  {booking.travelDate} · {productLabel}
                </Text>
                <InlineStack gap="200" align="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    상태
                  </Text>
                  <Badge tone={data.tourCompleted ? "success" : statusDisplay.tone}>{data.tourCompleted ? "투어 완료 · TOUR COMPLETED" : statusDisplay.label}</Badge>
                </InlineStack>
              </BlockStack>
              <InlineStack gap="200">
                <Button onClick={handleOpenOrder} disabled={!orderLink}>
                  Shopify 주문 보기
                </Button>
                <Button variant="primary" onClick={handlePdfDownload}>
                  PDF 다운로드
                </Button>
              </InlineStack>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">투어 완료</Text>
            <Text as="p">실제 투어가 끝난 뒤 완료 처리해 주세요. 완료 전에는 고객이 리뷰를 작성할 수 없습니다.</Text>
            {data.completionError ? <Banner tone="warning"><p>{data.completionError}</p></Banner> : null}
            <Form method="post">
              <input type="hidden" name="intent" value="complete_tour" />
              <Button submit variant="primary" disabled={isLoading || !data.canCompleteTour}>
                {data.tourCompleted ? "투어 완료됨" : "투어 완료 처리"}
              </Button>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Booking Summary
            </Text>
            <Text as="p" variant="bodyMd">
              여행일: {booking.travelDate}
            </Text>
            <Text as="p" variant="bodyMd">
              상품: {productLabel}
            </Text>
            <InlineStack gap="400">
              <Text as="span" variant="bodyMd">
                Mode: {booking.bookingMode}
              </Text>
              <Text as="span" variant="bodyMd">
                Pool: {booking.poolKey}
              </Text>
              <Text as="span" variant="bodyMd">
                Guide Units: {booking.guideUnitsRequired}
              </Text>
            </InlineStack>
            <Text as="p" variant="bodyMd">
              Order ID: {booking.orderId}
            </Text>
            <Text as="p" variant="bodyMd">
              Order Name: {order?.name || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              Financial: {order?.displayFinancialStatus || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              Fulfillment: {order?.displayFulfillmentStatus || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              Processed At: {order?.processedAt || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              Cancelled At: {order?.cancelledAt || "-"}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Reschedule
            </Text>
            <Text as="p" variant="bodyMd">
              현재 여행일: {booking.travelDate}
            </Text>
            {actionData?.ok === false ? (
              <Banner tone="critical">
                <p>{actionData.errorMessage}</p>
              </Banner>
            ) : null}
            {actionData?.ok === true && actionData.warningMessage ? (
              <Banner tone="warning">
                <p>{actionData.warningMessage}</p>
              </Banner>
            ) : null}
            {actionData?.ok === true ? (
              <Banner tone="success">
                <p>{actionData.successMessage}</p>
              </Banner>
            ) : null}
            <Form method="post">
              <input
                type="hidden"
                name="intent"
                value="reschedule_travel_date"
              />
              <FormLayout>
                <TextField
                  name="newTravelDate"
                  type="date"
                  label="New travel date"
                  value={newTravelDate}
                  onChange={(value) => {
                    setNewTravelDate(value);
                  }}
                  error={
                    actionData?.ok === false
                      ? actionData.fieldErrors?.newTravelDate
                      : undefined
                  }
                  disabled={!rescheduleEnabled}
                  autoComplete="off"
                />
                <Button submit disabled={!rescheduleEnabled}>
                  Save
                </Button>
              </FormLayout>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Travelers
            </Text>
            <Text as="p" variant="bodyMd">
              {formatTravelers(booking.travelers)}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Total: {formatTravelersTotal(booking.travelers)}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Customer
            </Text>
            {order ? (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd">
                  이름: {order.customer?.name || "-"}
                </Text>
                <Text as="p" variant="bodyMd">
                  이메일: {order.customer?.email || "-"}
                </Text>
                <Text as="p" variant="bodyMd">
                  전화번호: {order.customer?.phone || "-"}
                </Text>
              </BlockStack>
            ) : (
              <Text as="p" variant="bodyMd" tone="subdued">
                주문 정보를 불러올 수 없습니다.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Reservation Contact
            </Text>
            {extras?.mismatch ? (
              <Banner tone="warning">
                <p>여러 값이 감지되어 첫 번째 값만 표시합니다.</p>
              </Banner>
            ) : null}
            <Text as="p" variant="bodyMd">
              예약자 이름: {reservationContactName}
            </Text>
            <Text as="p" variant="bodyMd">
              예약자 연락처: {reservationContactPhone}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Extras
            </Text>
            {extras?.mismatch ? (
              <Banner tone="warning">
                <p>여러 값이 감지되어 첫 번째 값만 표시합니다.</p>
              </Banner>
            ) : null}
            <Text as="p" variant="bodyMd">
              픽업요청 장소: {pickupLocation}
            </Text>
            <Text as="p" variant="bodyMd">
              식사 제한사항: {dietaryRestrictions}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <details>
              <summary>System</summary>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm" tone="subdued">
                  Booking ID: {booking.bookingId}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Group Key: {booking.groupKey}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Created At: {booking.createdAt}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Updated At: {booking.updatedAt}
                </Text>
              </BlockStack>
            </details>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
