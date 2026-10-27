/**
 * Webhook 그룹 집계 로직
 * Phase 5-7: 여러 variant line_items를 "여행상품 그룹"으로 묶기
 * Phase X: groupKey 규칙 통일 (createGroupKey 유틸 사용)
 */

import type { BookingInfo } from "./webhookUtils";
import { createGroupKey } from "./groupKey";

/**
 * Line Item 타입
 */
export interface LineItem {
  id: number | string;
  product_id?: number | string;
  variant_id?: number | string;
  properties?: Array<{ name: string; value: string }>;
  [key: string]: unknown;
}

/**
 * 그룹화된 Line Items
 */
export interface GroupedLineItems {
  groupKey: string;
  lineItems: Array<LineItem>;
  bookingInfo: BookingInfo;
}

/**
 * Line items를 그룹으로 묶습니다.
 * @param lineItems Shopify line items 배열
 * @param extractBookingInfo 예약정보 추출 함수 (async)
 * @param shop shop 도메인 (resolver fallback용)
 * @returns 그룹화된 line items 배열
 */
export async function groupLineItemsByBooking(
  lineItems: Array<LineItem>,
  extractBookingInfo: (lineItem: LineItem, shop?: string) => Promise<BookingInfo | null>,
  shop?: string
): Promise<Array<GroupedLineItems>> {
  const groups = new Map<string, GroupedLineItems>();

  for (const lineItem of lineItems) {
    const bookingInfo = await extractBookingInfo(lineItem, shop);
    if (!bookingInfo) {
      continue; // 여행상품이 아니면 스킵
    }

    // properties에서 holdId 추출
    const properties = lineItem.properties || [];
    const holdIdProp = properties.find(
      (p) => p.name === "hold_id" || p.name === "holdId"
    );
    const holdId = holdIdProp?.value;

    // 그룹 키 생성 (Phase X: 통일된 규칙 사용)
    const groupKey = createGroupKey({
      travelDate: bookingInfo.travelDate,
      productId: bookingInfo.productId,
      poolKey: bookingInfo.poolKey,
      bookingMode: bookingInfo.bookingMode,
      holdId,
    });

    // 그룹에 추가
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        lineItems: [],
        bookingInfo,
      });
    }

    groups.get(groupKey)!.lineItems.push(lineItem);
  }

  return Array.from(groups.values());
}

