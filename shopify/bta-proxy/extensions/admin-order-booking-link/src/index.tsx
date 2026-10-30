import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: import("@shopify/ui-extensions/admin.order-details.action.render").Api;

type Status = "loading" | "error" | "ready_linkable" | "ready_unlinked";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const api = shopify;
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [orderName, setOrderName] = useState("");
  const [bookingId, setBookingId] = useState("");
  const [travelDate, setTravelDate] = useState("");

  const decodeJwtPayload = (token: string) => {
    try {
      const [, payload] = token.split(".");
      if (!payload) {
        return null;
      }
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
      if (typeof atob !== "function") {
        return null;
      }
      const json = atob(padded);
      return JSON.parse(json) as { iss?: string; dest?: string };
    } catch {
      return null;
    }
  };

  const orderId = useMemo(() => api.data?.selected?.[0]?.id, [api.data]);

  useEffect(() => {
    if (!orderId) {
      console.error("Missing order context", { data: api.data });
      setErrorMessage("주문 컨텍스트를 찾을 수 없습니다.");
      setStatus("error");
      return;
    }

    (async function fetchOrderMeta() {
      setStatus("loading");
      const query = `
        query OrderMeta($id: ID!) {
          order(id: $id) {
            name
            bookingId: metafield(namespace: "bta", key: "booking_id") {
              value
            }
            travelDate: metafield(namespace: "bta", key: "travel_date") {
              value
            }
          }
        }
      `;

      try {
        const response = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          body: JSON.stringify({ query, variables: { id: orderId } }),
        });
        const result = (await response.json()) as {
          data?: {
            order?: {
              name?: string;
              bookingId?: { value?: string };
              travelDate?: { value?: string };
            };
          };
          errors?: Array<{ message: string }>;
        };

        if (result.errors && result.errors.length > 0) {
          throw new Error(result.errors.map((e) => e.message).join(", "));
        }

        const order = result.data?.order;
        if (!order) {
          throw new Error("Order not found");
        }

        const bookingIdValue = order.bookingId?.value || "";
        const travelDateValue = order.travelDate?.value || "";
        setOrderName(order.name || "-");
        setBookingId(bookingIdValue);
        setTravelDate(travelDateValue);
        setStatus(bookingIdValue ? "ready_linkable" : "ready_unlinked");
      } catch (error) {
        console.error("Failed to fetch order metafields", error);
        setErrorMessage("예약 정보 조회 실패");
        setStatus("error");
      }
    })();
  }, [api, orderId]);

  const canLink = status === "ready_linkable" && Boolean(bookingId);
  const bookingLabel = bookingId || "연결된 예약 없음";
  const travelLabel = travelDate || "미설정";

  // 인증 토큰에서 shop 정보를 추출하여 URL 생성
  const [bookingDetailUrl, setBookingDetailUrl] = useState<string | null>(null);

  useEffect(() => {
    if (canLink && bookingId) {
      (async () => {
        try {
          const idToken = await api.auth.idToken();
          const payload = idToken ? decodeJwtPayload(idToken) : null;
          const dest = payload?.dest || payload?.iss;
          const shopDomain = dest ? new URL(dest).hostname : null;
          const storeHandle = shopDomain ? shopDomain.split(".")[0] : null;
          const adminAppBase = storeHandle
            ? `https://admin.shopify.com/store/${storeHandle}/apps/bta-proxy`
            : null;
          const url = adminAppBase ? `${adminAppBase}/app/bookings/${bookingId}` : null;

          setBookingDetailUrl(url);
        } catch (error) {
          console.error("Failed to generate URL", error);
        }
      })();
    }
  }, [canLink, bookingId, api]);

  return (
    <s-admin-action heading="예약 정보">
      {canLink && bookingDetailUrl ? (
        <s-button slot="primary-action" href={bookingDetailUrl}>
          예약 상세 열기
        </s-button>
      ) : (
        <s-button slot="primary-action" disabled>
          예약 상세 열기
        </s-button>
      )}
      <s-button slot="secondary-actions" onClick={() => api.close()}>
        닫기
      </s-button>
      <s-stack direction="block" gap="base">
        <s-text type="strong">예약 정보</s-text>
        {status === "loading" ? <s-spinner size="base" /> : null}
        {status === "error" ? <s-text>{errorMessage}</s-text> : null}
        {status !== "loading" && status !== "error" ? (
          <s-stack direction="block" gap="base">
            <s-text>주문: {orderName}</s-text>
            <s-text>예약 ID: {bookingLabel}</s-text>
            <s-text>여행일: {travelLabel}</s-text>
          </s-stack>
        ) : null}
      </s-stack>
    </s-admin-action>
  );
}
