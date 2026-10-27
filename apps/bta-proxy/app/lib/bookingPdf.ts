import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  getBookingStatusDisplay,
  normalizeBookingStatus,
} from "./bookingStatus";
import type { BookingDetailData } from "./bookingDetailService";

const FONT_CANDIDATES = [
  path.resolve(
    process.cwd(),
    "app/assets/fonts/NotoSansKR-VariableFont_wght.ttf",
  ),
  path.resolve(process.cwd(), "public/fonts/NotoSansKR-VariableFont_wght.ttf"),
];
const PAGE_MARGIN_X = 40;
const PAGE_MARGIN_Y = 40;
const MAX_LINE_CHARS = 80;

let cachedFontBytes: Uint8Array | null = null;

async function loadFontBytes(): Promise<Uint8Array | null> {
  if (cachedFontBytes) {
    return cachedFontBytes;
  }
  for (const candidate of FONT_CANDIDATES) {
    try {
      const rawBytes = await readFile(candidate);
      // Buffer를 완전히 새로운 ArrayBuffer로 복사 (fontkit 호환성을 위해)
      const rawBytesAny = rawBytes as any;
      if (Buffer.isBuffer(rawBytesAny)) {
        // Buffer를 완전히 새로운 ArrayBuffer로 복사 (뷰가 아닌 실제 복사)
        const arrayBuffer = new ArrayBuffer(rawBytesAny.length);
        const newUint8Array = new Uint8Array(arrayBuffer);
        newUint8Array.set(rawBytesAny);
        cachedFontBytes = newUint8Array;
      } else if (rawBytesAny instanceof Uint8Array) {
        // Uint8Array를 완전히 새로운 ArrayBuffer로 복사
        const arrayBuffer = new ArrayBuffer(rawBytesAny.length);
        const newUint8Array = new Uint8Array(arrayBuffer);
        newUint8Array.set(rawBytesAny);
        cachedFontBytes = newUint8Array;
      } else {
        cachedFontBytes = rawBytesAny as Uint8Array;
      }

      // 폰트 파일 시그니처 확인 (TTF: 00 01 00 00, OTF: 4F 54 54 4F, wOFF: 77 4F 46 46)
      const first4Bytes = Array.from(cachedFontBytes.slice(0, 4));
      const first4BytesHex = first4Bytes
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const first16BytesHex = Array.from(cachedFontBytes.slice(0, 16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      const isTTF = first4BytesHex === "00 01 00 00";
      const isOTF = first4BytesHex === "4f 54 54 4f";
      const isWOFF = first4BytesHex === "77 4f 46 46";
      const isValidFont = isTTF || isOTF || isWOFF;
      const appearsToBeHTML = first16BytesHex.includes(
        "3c 21 44 4f 43 54 59 50",
      ); // <!DOCTYPE

      if (!isValidFont) {
        // HTML 파일로 보이는 경우 더 명확한 에러 메시지
        if (appearsToBeHTML) {
          throw new Error(
            `Font file appears to be HTML instead of a valid font file. The file at ${candidate} contains HTML content (starts with "<!DOCTYPE"). Please ensure you have a valid TTF/OTF font file.`,
          );
        }
        throw new Error(
          `Invalid font file signature. First 4 bytes: ${first4BytesHex}. Expected TTF (00 01 00 00), OTF (4f 54 54 4f), or WOFF (77 4f 46 46). File: ${candidate}`,
        );
      }
      console.log(`Korean font loaded successfully from: ${candidate}`);
      return cachedFontBytes;
    } catch (error) {
      console.warn(`Failed to load font from ${candidate}:`, error);
      // try next candidate
    }
  }
  cachedFontBytes = null;
  return cachedFontBytes;
}

async function embedFont(pdfDoc: PDFDocument): Promise<any> {
  const fontBytes = await loadFontBytes();
  if (!fontBytes) {
    const candidates = FONT_CANDIDATES.join(", ");
    throw new Error(`Korean font not found. Tried: ${candidates}`);
  }

  // Buffer인 경우 Uint8Array로 변환
  const fontBytesForEmbed =
    fontBytes instanceof Buffer ? new Uint8Array(fontBytes) : fontBytes;
  try {
    // 커스텀 폰트 임베딩 시도 (fontkit이 등록되어 있어야 함)
    return await pdfDoc.embedFont(fontBytesForEmbed);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to embed Korean font: ${errorMsg}`);
  }
}

function wrapText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    lines.push(remaining.slice(0, maxChars));
    remaining = remaining.slice(maxChars);
  }
  if (remaining) {
    lines.push(remaining);
  }
  return lines;
}

function sanitizeText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

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

export async function buildBookingPdf(
  detail: BookingDetailData,
): Promise<Uint8Array> {
  // fontkit 등록 확인 (PDFDocument 생성 전에 확인)
  const fontkitRaw = fontkit as any;
  const fontkitInstance = fontkitRaw?.default ?? fontkit;
  if (!fontkitInstance) {
    throw new Error("Fontkit is not available");
  }

  const pdfDoc = await PDFDocument.create();

  // fontkit 등록 (PDFDocument 생성 후 등록)
  try {
    pdfDoc.registerFontkit(fontkitInstance);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to register fontkit: ${errorMsg}`);
  }

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await embedFont(pdfDoc);
  let y = page.getHeight() - PAGE_MARGIN_Y;

  const drawLines = (lines: string[], size: number, lineHeight: number) => {
    for (const line of lines) {
      page.drawText(line, { x: PAGE_MARGIN_X, y, size, font });
      y -= lineHeight;
    }
  };

  const drawLabel = (label: string, value: string, size = 11) => {
    const safeValue = sanitizeText(value);
    const text = `${label}: ${safeValue}`;
    drawLines(wrapText(text, MAX_LINE_CHARS), size, size + 4);
  };

  const booking = detail.booking;
  const order = detail.order;
  const extras = detail.bookingExtras;
  const statusDisplay = getBookingStatusDisplay(
    normalizeBookingStatus(booking.status),
  );

  const productLabel =
    booking.productTitle || order?.title || booking.productId;
  const pickupLocation = extras?.pickupLocation || "-";
  const dietaryRestrictions = extras?.dietaryRestrictions || "-";
  const reservationContactName = extras?.reservationContactName || "-";
  const reservationContactPhone = extras?.reservationContactPhone || "-";

  drawLines([`Booking Detail`], 16, 24);
  drawLabel("상태", statusDisplay.label, 12);
  drawLabel("여행일", booking.travelDate, 12);
  drawLabel("상품", productLabel, 12);
  drawLines([""], 10, 14);

  drawLines(["예약 요약"], 13, 18);
  drawLabel("Mode", booking.bookingMode);
  drawLabel("Pool", booking.poolKey);
  drawLabel("Guide Units", String(booking.guideUnitsRequired));
  drawLabel("Order ID", booking.orderId);
  drawLabel("Order Name", order?.name || "-");
  drawLabel("Financial", order?.displayFinancialStatus || "-");
  drawLabel("Fulfillment", order?.displayFulfillmentStatus || "-");
  drawLabel("Processed At", order?.processedAt || "-");
  drawLabel("Cancelled At", order?.cancelledAt || "-");
  drawLines([""], 10, 14);

  drawLines(["인원 정보"], 13, 18);
  drawLabel("Travelers", formatTravelers(booking.travelers));
  drawLabel("Total", formatTravelersTotal(booking.travelers));
  drawLines([""], 10, 14);

  drawLines(["고객 정보"], 13, 18);
  drawLabel("이름", order?.customer?.name || "-");
  drawLabel("이메일", order?.customer?.email || "-");
  drawLabel("전화번호", order?.customer?.phone || "-");
  drawLines([""], 10, 14);

  drawLines(["예약자 정보"], 13, 18);
  drawLabel("예약자 이름", reservationContactName);
  drawLabel("예약자 연락처", reservationContactPhone);
  drawLines([""], 10, 14);

  drawLines(["추가 요청"], 13, 18);
  drawLabel("픽업요청 장소", pickupLocation);
  drawLabel("식사 제한사항", dietaryRestrictions);
  if (extras?.mismatch) {
    drawLabel("주의", "여러 값이 감지되어 첫 번째 값만 표시");
  }
  drawLines([""], 10, 14);

  drawLines(["주문 정보"], 13, 18);
  drawLabel("Shopify 주문 링크", detail.orderUrl || "-");
  drawLines([""], 10, 14);

  drawLines(["시스템 정보"], 13, 18);
  drawLabel("Booking ID", booking.bookingId);
  drawLabel("Group Key", booking.groupKey);
  drawLabel("Created At", booking.createdAt);
  drawLabel("Updated At", booking.updatedAt);

  return await pdfDoc.save();
}
