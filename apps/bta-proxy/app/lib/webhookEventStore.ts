/**
 * Webhook Event Store
 * Phase 1: 이벤트 저장/멱등 파이프라인
 * 
 * SSOT 기반: webhook_events 테이블에 이벤트 저장 및 중복 방지
 */

import { createHash } from "crypto";
import db from "~/db.server";

export type WebhookEventStatus = "PENDING" | "PROCESSED" | "FAILED";

export interface SaveWebhookEventResult {
  saved: boolean;
  eventKey: string;
  isDuplicate: boolean;
  existingId?: string;
  existingStatus?: string;
}

export interface WebhookEventEvaluationUpdate {
  normalizedStatus: string | null;
  extractedHoldIds: string[];
  extractedAttemptIds: string[];
  evaluationError?: string | null;
}

export interface WebhookEventReleaseUpdate {
  releaseResults: Array<{
    holdId: string;
    status: "SUCCESS" | "SKIPPED" | "FAILED" | "DRYRUN";
    reason?: string | null;
    error?: string | null;
  }>;
  releaseStatus: "SUCCESS" | "SKIPPED" | "FAILED" | "PARTIAL" | "DRYRUN";
  releaseReason?: string | null;
  releaseRetryCount?: number;
  releaseLastError?: string | null;
  releaseLastAttemptAt?: Date | null;
}

function getWebhookEventModel(): any | null {
  const model = (db as any)?.webhookEvent;
  if (!model) {
    if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
      throw new Error("Durable webhook storage unavailable");
    }
    console.warn(
      JSON.stringify({
        message: "WebhookEvent model unavailable",
      })
    );
    return null;
  }
  return model;
}

/**
 * Event key 생성 규칙
 * 1. Shopify webhook id 헤더가 있으면 우선 사용
 * 2. 없으면 (topic + rawBody hash)로 생성
 */
export function generateEventKey(
  topic: string,
  rawBody: string,
  webhookId?: string | null
): string {
  if (webhookId) {
    return webhookId;
  }
  
  // topic + rawBody의 SHA256 해시
  const hash = createHash("sha256")
    .update(`${topic}:${rawBody}`)
    .digest("hex");
  return hash;
}

/**
 * Payload hash 생성 (SHA256)
 */
export function generatePayloadHash(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

/**
 * Webhook 이벤트 저장 (멱등성 보장)
 * 
 * @param topic Webhook topic (예: "orders/paid", "orders/cancelled", "refunds/create")
 * @param rawBody Raw body (JSON 파싱 전)
 * @param orderId Order ID (payload에서 추출, nullable)
 * @param webhookId Shopify webhook id 헤더 (X-Shopify-Webhook-Id, optional)
 * @returns 저장 결과 (중복이면 isDuplicate: true)
 */
export async function saveWebhookEvent(
  topic: string,
  rawBody: string,
  orderId: string | null = null,
  webhookId?: string | null
): Promise<SaveWebhookEventResult> {
  const eventKey = generateEventKey(topic, rawBody, webhookId);
  const payloadHash = generatePayloadHash(rawBody);
  const webhookEvent = getWebhookEventModel();

  if (!webhookEvent) {
    return {
      saved: false,
      eventKey,
      isDuplicate: false,
    };
  }

  try {
    // 기존 이벤트 확인 (eventKey로 중복 체크)
    const existing = await webhookEvent.findUnique({
      where: { eventKey },
      select: { id: true, status: true },
    });

    if (existing) {
      // 중복 이벤트
      return {
        saved: false,
        eventKey,
        isDuplicate: true,
        existingId: existing.id,
        existingStatus: existing.status,
      };
    }

    // 새 이벤트 저장
    const event = await webhookEvent.create({
      data: {
        topic,
        eventKey,
        orderId,
        payloadJson: rawBody,
        payloadHash,
        status: "PENDING",
        receivedAt: new Date(),
      },
    });

    return {
      saved: true,
      eventKey,
      isDuplicate: false,
      existingId: event.id,
    };
  } catch (error) {
    // Unique constraint violation (동시성 이슈)
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
    ) {
      // 중복으로 처리
      const existing = await webhookEvent.findUnique({
        where: { eventKey },
        select: { id: true, status: true },
      });

      return {
        saved: false,
        eventKey,
        isDuplicate: true,
        existingId: existing?.id,
        existingStatus: existing?.status,
      };
    }

    // 기타 에러는 재throw
    throw error;
  }
}

/**
 * Webhook 이벤트의 orderId 업데이트
 * (JSON 파싱 후 orderId를 알 수 있을 때 호출)
 */
export async function updateWebhookEventOrderId(
  eventKey: string,
  orderId: string
): Promise<void> {
  const webhookEvent = getWebhookEventModel();
  if (!webhookEvent) return;
  await webhookEvent.update({
    where: { eventKey },
    data: { orderId },
  });
}

/**
 * Webhook 이벤트 상태 업데이트
 * (Phase 2/3에서 사용 예정)
 */
export async function updateWebhookEventStatus(
  eventKey: string,
  status: WebhookEventStatus,
  error?: string | null
): Promise<void> {
  const webhookEvent = getWebhookEventModel();
  if (!webhookEvent) return;
  await webhookEvent.update({
    where: { eventKey },
    data: {
      status,
      error: error || null,
      processedAt: status !== "PENDING" ? new Date() : null,
    },
  });
}

/**
 * Webhook 이벤트 평가 결과 업데이트 (Phase 2 드라이런)
 */
export async function updateWebhookEventEvaluation(
  eventKey: string,
  update: WebhookEventEvaluationUpdate
): Promise<void> {
  const webhookEvent = getWebhookEventModel();
  if (!webhookEvent) return;
  await webhookEvent.update({
    where: { eventKey },
    data: {
      normalizedStatus: update.normalizedStatus,
      extractedHoldIds: JSON.stringify(update.extractedHoldIds || []),
      extractedAttemptIds: JSON.stringify(update.extractedAttemptIds || []),
      evaluationError: update.evaluationError || null,
    },
  });
}

/**
 * Webhook 이벤트 release 결과 업데이트 (Phase 3)
 */
export async function updateWebhookEventRelease(
  eventKey: string,
  update: WebhookEventReleaseUpdate
): Promise<void> {
  const webhookEvent = getWebhookEventModel();
  if (!webhookEvent) return;
  await webhookEvent.update({
    where: { eventKey },
    data: {
      releaseResults: JSON.stringify(update.releaseResults || []),
      releaseStatus: update.releaseStatus,
      releaseReason: update.releaseReason || null,
      releaseRetryCount: update.releaseRetryCount,
      releaseLastError: update.releaseLastError ?? null,
      releaseLastAttemptAt: update.releaseLastAttemptAt ?? null,
    },
  });
}

/**
 * Webhook 이벤트 release 상태 조회
 */
export async function getWebhookEventReleaseStatus(
  eventKey: string
): Promise<{
  releaseStatus: string | null;
  releaseResults: string | null;
  releaseReason: string | null;
  releaseRetryCount: number | null;
  releaseLastAttemptAt: Date | null;
} | null> {
  const webhookEvent = getWebhookEventModel();
  if (!webhookEvent) return null;
  return await webhookEvent.findUnique({
    where: { eventKey },
    select: {
      releaseStatus: true,
      releaseResults: true,
      releaseReason: true,
      releaseRetryCount: true,
      releaseLastAttemptAt: true,
    },
  });
}

export interface ReconciliationCandidate {
  eventKey: string;
  orderId: string | null;
  topic: string;
  normalizedStatus: string | null;
  extractedHoldIds: string | null;
  extractedAttemptIds: string | null;
  releaseStatus: string | null;
  releaseRetryCount: number | null;
  releaseLastAttemptAt: Date | null;
  releaseLastError: string | null;
  receivedAt: Date;
}

export async function listReconciliationCandidates(params: {
  maxRetries: number;
  limit?: number;
}): Promise<ReconciliationCandidate[]> {
  const { maxRetries, limit = 200 } = params;
  const webhookEvent = getWebhookEventModel();
  if (!webhookEvent) return [];
  return await webhookEvent.findMany({
    where: {
      normalizedStatus: "TERMINAL_FAIL_RELEASE",
      releaseRetryCount: { lt: maxRetries },
      OR: [{ releaseStatus: null }, { releaseStatus: "FAILED" }],
    },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: {
      eventKey: true,
      orderId: true,
      topic: true,
      normalizedStatus: true,
      extractedHoldIds: true,
      extractedAttemptIds: true,
      releaseStatus: true,
      releaseRetryCount: true,
      releaseLastAttemptAt: true,
      releaseLastError: true,
      receivedAt: true,
    },
  });
}
