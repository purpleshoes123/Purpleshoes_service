/**
 * Phase 3: Hold Release Executor
 */

import { getBookingStore } from "~/lib/bookingStore";
import {
  getWebhookEventReleaseStatus,
  updateWebhookEventRelease,
  type WebhookEventReleaseUpdate,
} from "~/lib/webhookEventStore";

export interface HoldReleaseInput {
  eventKey: string;
  orderId: string;
  normalizedStatus: string | null;
  holdIds: string[];
  attemptIds: string[];
  topic: string;
  dryrun: boolean;
  forceCancel?: boolean;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUpdate(
  releaseResults: WebhookEventReleaseUpdate["releaseResults"],
  releaseReason?: string | null
): WebhookEventReleaseUpdate {
  const hasFailed = releaseResults.some((r) => r.status === "FAILED");
  const hasSuccess = releaseResults.some((r) => r.status === "SUCCESS");
  const hasSkipped = releaseResults.some((r) => r.status === "SKIPPED");
  const hasDryrun = releaseResults.some((r) => r.status === "DRYRUN");

  let releaseStatus: WebhookEventReleaseUpdate["releaseStatus"] = "SKIPPED";
  if (hasFailed) {
    releaseStatus = hasSuccess ? "PARTIAL" : "FAILED";
  } else if (hasDryrun) {
    releaseStatus = "DRYRUN";
  } else if (hasSuccess && hasSkipped) {
    releaseStatus = "PARTIAL";
  } else if (hasSuccess) {
    releaseStatus = "SUCCESS";
  } else if (hasSkipped) {
    releaseStatus = "SKIPPED";
  }

  return {
    releaseResults,
    releaseStatus,
    releaseReason: releaseReason || null,
  };
}

function logReleaseEvent(params: {
  orderId: string;
  eventKey: string;
  topic: string;
  normalizedStatus: string | null;
  holdIds: string[];
  releaseStatus: string;
  errorCode?: string | null;
  retryCount?: number | null;
}) {
  console.log(
    JSON.stringify({
      message: "Hold release result",
      order_id: params.orderId,
      event_key: params.eventKey,
      topic: params.topic,
      normalized_status: params.normalizedStatus,
      hold_id: params.holdIds,
      release_status: params.releaseStatus,
      error_code: params.errorCode || null,
      retry_count: params.retryCount ?? null,
    })
  );
}

export async function executeHoldRelease(input: HoldReleaseInput): Promise<void> {
  const {
    eventKey,
    orderId,
    normalizedStatus,
    holdIds,
    attemptIds,
    topic,
    dryrun,
    forceCancel,
  } = input;
  const allowForceCancel = forceCancel === true;

  // 이미 처리된 이벤트면 스킵
  const existing = await getWebhookEventReleaseStatus(eventKey);
  if (existing?.releaseStatus) {
    await updateWebhookEventRelease(eventKey, {
      releaseResults: [],
      releaseStatus: "SKIPPED",
      releaseReason: "ALREADY_PROCESSED",
    });
    logReleaseEvent({
      orderId,
      eventKey,
      topic,
      normalizedStatus,
      holdIds,
      releaseStatus: "SKIPPED",
      errorCode: "ALREADY_PROCESSED",
      retryCount: existing?.releaseRetryCount ?? null,
    });
    return;
  }

  // 대상 status만 실행
  if (normalizedStatus !== "TERMINAL_FAIL_RELEASE") {
    await updateWebhookEventRelease(eventKey, {
      releaseResults: [],
      releaseStatus: "SKIPPED",
      releaseReason: "NOT_TARGET_STATUS",
    });
    logReleaseEvent({
      orderId,
      eventKey,
      topic,
      normalizedStatus,
      holdIds,
      releaseStatus: "SKIPPED",
      errorCode: "NOT_TARGET_STATUS",
      retryCount: existing?.releaseRetryCount ?? null,
    });
    return;
  }

  // allowlist 가드레일 (기본: 비어 있으면 실행 금지)
  const allowTopics = (process.env.HOLD_RELEASE_VOID_ALLOW_TOPICS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowTopics.length === 0 && !allowForceCancel) {
    await updateWebhookEventRelease(eventKey, {
      releaseResults: [],
      releaseStatus: "SKIPPED",
      releaseReason: "ALLOWLIST_EMPTY",
    });
    logReleaseEvent({
      orderId,
      eventKey,
      topic,
      normalizedStatus,
      holdIds,
      releaseStatus: "SKIPPED",
      errorCode: "ALLOWLIST_EMPTY",
      retryCount: existing?.releaseRetryCount ?? null,
    });
    return;
  }
  if (!allowTopics.includes(topic) && !allowForceCancel) {
    await updateWebhookEventRelease(eventKey, {
      releaseResults: [],
      releaseStatus: "SKIPPED",
      releaseReason: "ALLOWLIST_MISMATCH",
    });
    logReleaseEvent({
      orderId,
      eventKey,
      topic,
      normalizedStatus,
      holdIds,
      releaseStatus: "SKIPPED",
      errorCode: "ALLOWLIST_MISMATCH",
      retryCount: existing?.releaseRetryCount ?? null,
    });
    return;
  }
  if (allowForceCancel && (allowTopics.length === 0 || !allowTopics.includes(topic))) {
    console.warn(
      JSON.stringify({
        message: "Force cancel release bypassed allowlist",
        order_id: orderId,
        event_key: eventKey,
        topic,
      })
    );
  }

  // attemptId 필수 (취소 강제 모드에서는 우회)
  if ((!attemptIds || attemptIds.length === 0) && !allowForceCancel) {
    await updateWebhookEventRelease(eventKey, {
      releaseResults: [],
      releaseStatus: "SKIPPED",
      releaseReason: "ATTEMPT_ID_REQUIRED",
    });
    logReleaseEvent({
      orderId,
      eventKey,
      topic,
      normalizedStatus,
      holdIds,
      releaseStatus: "SKIPPED",
      errorCode: "ATTEMPT_ID_REQUIRED",
      retryCount: existing?.releaseRetryCount ?? null,
    });
    return;
  }
  if ((!attemptIds || attemptIds.length === 0) && allowForceCancel) {
    console.warn(
      JSON.stringify({
        message: "Force cancel release without attemptId",
        order_id: orderId,
        event_key: eventKey,
        topic,
      })
    );
  }

  // holdId 없으면 스킵
  if (!holdIds || holdIds.length === 0) {
    await updateWebhookEventRelease(eventKey, {
      releaseResults: [],
      releaseStatus: "SKIPPED",
      releaseReason: "HOLD_ID_MISSING",
    });
    logReleaseEvent({
      orderId,
      eventKey,
      topic,
      normalizedStatus,
      holdIds,
      releaseStatus: "SKIPPED",
      errorCode: "HOLD_ID_MISSING",
      retryCount: existing?.releaseRetryCount ?? null,
    });
    return;
  }

  const results: WebhookEventReleaseUpdate["releaseResults"] = [];
  const retryCount = existing?.releaseRetryCount ?? 0;
  const nextRetryCount = dryrun ? retryCount : retryCount + 1;
  const now = new Date();

  if (dryrun) {
    for (const holdId of holdIds) {
      results.push({
        holdId,
        status: "DRYRUN",
        reason: "DRYRUN",
      });
    }
    await updateWebhookEventRelease(eventKey, {
      ...buildUpdate(results, "DRYRUN"),
      releaseRetryCount: nextRetryCount,
    });
    logReleaseEvent({
      orderId,
      eventKey,
      topic,
      normalizedStatus,
      holdIds,
      releaseStatus: "DRYRUN",
      errorCode: "DRYRUN",
      retryCount: nextRetryCount,
    });
    return;
  }

  const store = getBookingStore();

  for (const holdId of holdIds) {
    let success = false;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        await store.releaseHold(holdId);
        success = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const normalizedError = String(lastError).toLowerCase();
        if (
          normalizedError.includes("not found") ||
          normalizedError.includes("already released") ||
          normalizedError.includes("404")
        ) {
          // 이미 해제됨/없음은 성공으로 간주
          success = true;
          break;
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }

    if (success) {
      results.push({ holdId, status: "SUCCESS" });
    } else {
      results.push({
        holdId,
        status: "FAILED",
        error: lastError || "unknown",
      });
    }
  }

  const lastError =
    results.find((result) => result.status === "FAILED")?.error || null;
  const update = buildUpdate(results, normalizedStatus || null);
  await updateWebhookEventRelease(eventKey, {
    ...update,
    releaseRetryCount: nextRetryCount,
    releaseLastError: lastError,
    releaseLastAttemptAt: now,
  });
  logReleaseEvent({
    orderId,
    eventKey,
      topic,
      normalizedStatus,
    holdIds,
      releaseStatus: update.releaseStatus,
    errorCode: lastError,
    retryCount: nextRetryCount,
  });
}
