import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ConfirmedBookingRecord } from "./rebuildStore";
import { createGroupKey } from "./groupKey";
import { isTourLineCompleted, tourCompletionTag } from "./tourCompletion";

export const COMPLETION_ORDER_QUERY = `
  query BookingCompletionOrder($id: ID!, $after: String) {
    order(id: $id) {
      id cancelledAt displayFinancialStatus tags
      lineItems(first: 100, after: $after) {
        nodes { id product { id } customAttributes { key value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const COMPLETE_TOUR_MUTATION = `
  mutation CompleteTour($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }
`;

type OrderLine = {
  id: string;
  product?: { id: string } | null;
  customAttributes: Array<{ key: string; value: string }>;
};

type CompletionOrder = {
  id: string;
  cancelledAt?: string | null;
  displayFinancialStatus: string;
  tags: string[];
  lineItems: { nodes: OrderLine[]; pageInfo: { hasNextPage: boolean; endCursor?: string | null } };
};

function matchesBooking(line: OrderLine, booking: ConfirmedBookingRecord): boolean {
  const productId = line.product?.id.replace(/^gid:\/\/shopify\/Product\//, "");
  if (productId !== booking.productId.replace(/^gid:\/\/shopify\/Product\//, "")) return false;
  const read = (...keys: string[]) => line.customAttributes.find(a => keys.includes(a.key))?.value;
  const travelDate = read("travel_date", "travelDate");
  if (!travelDate) return false;
  const holdId = read("hold_id", "holdId");
  const values = {
    productId, travelDate,
    poolKey: read("pool_key", "poolKey") || undefined,
    bookingMode: read("booking_mode", "bookingMode") === "shared" ? "shared" as const : "private" as const,
  };
  return [holdId, holdId || booking.orderId.replace(/^gid:\/\/shopify\/Order\//, "")]
    .some(id => createGroupKey({ ...values, holdId: id }) === booking.groupKey);
}

export async function getBookingCompletion(admin: AdminApiContext, booking: ConfirmedBookingRecord) {
  const id = booking.orderId.startsWith("gid://") ? booking.orderId : `gid://shopify/Order/${booking.orderId}`;
  let after: string | null = null;
  const lines: OrderLine[] = [];
  let order: CompletionOrder | null = null;
  for (let page = 0; page < 20; page++) {
    const response: Response = await admin.graphql(COMPLETION_ORDER_QUERY, { variables: { id, after } });
    const payload = await response.json() as { errors?: unknown[]; data?: { order?: CompletionOrder | null } };
    if (!response.ok || payload.errors?.length || !payload.data?.order) throw new Error("주문 완료 상태를 확인하지 못했습니다.");
    const current = payload.data.order;
    order = current;
    lines.push(...current.lineItems.nodes.filter((line: OrderLine) => matchesBooking(line, booking)));
    if (!current.lineItems.pageInfo.hasNextPage) break;
    after = current.lineItems.pageInfo.endCursor || null;
    if (!after || page === 19) throw new Error("주문 품목을 모두 확인하지 못했습니다.");
  }
  if (!order || lines.length === 0) throw new Error("예약에 연결된 주문 품목을 찾지 못했습니다.");
  const active = !order.cancelledAt && order.displayFinancialStatus === "PAID";
  const completed = active && lines.every(line => isTourLineCompleted(order!.tags, line.id));
  return { orderId: order.id, active, completed, lineIds: lines.map(line => line.id) };
}

export async function completeBookingTour(admin: AdminApiContext, booking: ConfirmedBookingRecord, now = new Date()) {
  const state = await getBookingCompletion(admin, booking);
  if (!state.active) throw new Error("취소·환불 또는 미결제 예약은 완료 처리할 수 없습니다.");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking.travelDate) || booking.travelDate > today) throw new Error("투어 날짜 이전에는 완료 처리할 수 없습니다.");
  if (state.completed) return;
  const response: Response = await admin.graphql(COMPLETE_TOUR_MUTATION, {
    variables: { id: state.orderId, tags: state.lineIds.map(tourCompletionTag) },
  });
  const payload = await response.json();
  const result = payload.data?.tagsAdd;
  if (!response.ok || payload.errors?.length || !result?.node || result.userErrors?.length) throw new Error("투어 완료 저장에 실패했습니다. 다시 시도해 주세요.");
}
