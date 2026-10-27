/**
 * Webhook Void Normalizer
 * Phase 2: 주문 payload를 정규화된 종료 상태로 판정
 *
 * SSOT 규칙 기반 결정 트리:
 * - financial_status == voided
 * - cancelled_at 존재 + not paid
 * - transactions 내 authorization void 계열
 */

export type NormalizedTerminalStatus =
  | "TERMINAL_SUCCESS"
  | "TERMINAL_FAIL_RELEASE"
  | "TERMINAL_REFUND_RELEASE"
  | "NON_TERMINAL";

export interface NormalizeInput {
  topic: string;
  payload: Record<string, any>;
}

const PAID_STATUSES = new Set(["paid"]);
const REFUND_STATUSES = new Set(["refunded", "partially_refunded"]);
const VOID_STATUSES = new Set(["voided", "void", "authorization_voided"]);

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase();
}

function hasVoidTransaction(transactions: any[] | undefined): boolean {
  if (!Array.isArray(transactions)) return false;
  return transactions.some((tx) => {
    const status = normalizeString(tx?.status);
    const kind = normalizeString(tx?.kind);
    // authorization void 계열 또는 실패/무효 상태
    return (
      status === "voided" ||
      status === "void" ||
      status === "failed" ||
      status === "error" ||
      kind === "void" ||
      kind === "authorization_void" ||
      kind === "authorization_voided"
    );
  });
}

/**
 * 종료 상태 정규화
 */
export function normalizeTerminalStatus({
  topic,
  payload,
}: NormalizeInput): NormalizedTerminalStatus {
  const normalizedTopic = normalizeString(topic) || "";
  const financialStatus = normalizeString(payload?.financial_status);
  const cancelledAt = payload?.cancelled_at;
  const transactions = payload?.transactions;

  // orders/cancelled는 결제 완료 여부와 무관하게 release 대상으로 간주
  if (normalizedTopic === "orders/cancelled") {
    return "TERMINAL_FAIL_RELEASE";
  }

  // 1) 환불 webhook 또는 환불 상태
  if (normalizedTopic === "refunds/create") {
    return "TERMINAL_REFUND_RELEASE";
  }
  if (financialStatus && REFUND_STATUSES.has(financialStatus)) {
    return "TERMINAL_REFUND_RELEASE";
  }

  // 2) 명시적 void 상태
  if (financialStatus && VOID_STATUSES.has(financialStatus)) {
    return "TERMINAL_FAIL_RELEASE";
  }

  // 3) cancelled_at 존재 + not paid
  if (cancelledAt && (!financialStatus || !PAID_STATUSES.has(financialStatus))) {
    return "TERMINAL_FAIL_RELEASE";
  }

  // 4) transactions 기반 void 감지 (있을 때만)
  if (hasVoidTransaction(transactions)) {
    return "TERMINAL_FAIL_RELEASE";
  }

  // 5) paid
  if (financialStatus && PAID_STATUSES.has(financialStatus)) {
    return "TERMINAL_SUCCESS";
  }

  return "NON_TERMINAL";
}
