import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { verifyInternal } from "~/middleware/verifyInternal";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  listReconciliationCandidates,
  updateWebhookEventRelease,
} from "~/domains/webhooks/webhookEventStore";
import { executeHoldRelease } from "~/domains/webhooks/webhookHoldRelease";
import { maskPII } from "~/lib/masking";
import { acquireReconcileLock, releaseReconcileLock } from "~/domains/bookings/reconcileLock";

const reconcileQuerySchema = z.object({
  limit: z
    .string()
    .transform((value) => Number(value))
    .optional(),
  maxRetries: z
    .string()
    .transform((value) => Number(value))
    .optional(),
});

const BACKOFF_MS = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_LIMIT = 200;

function shouldRetry(lastAttemptAt: Date | null, retryCount: number, now: number): boolean {
  if (!lastAttemptAt) {
    return true;
  }
  const delay = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length - 1)];
  return now - lastAttemptAt.getTime() >= delay;
}

function safeParseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Phase 4: POST /proxy/internal/reconcile-holds
 * 내부 인증 (X-Internal-Token)
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  const authResponse = await verifyInternal(request);
  if (authResponse) {
    return authResponse;
  }

  const lockKey = "lock:reconcile-holds";
  const lockAcquired = await acquireReconcileLock(lockKey);
  if (!lockAcquired) {
    return respond.ok(
      {
        processed: 0,
        skipped: 0,
        reason: "LOCKED",
      },
      { correlationId },
    );
  }

  const pipelineEnabled = process.env.HOLD_RELEASE_VOID_PIPELINE_ENABLED === "true";
  const dryrun = process.env.HOLD_RELEASE_VOID_DRYRUN !== "false";

  try {
    if (!pipelineEnabled) {
      return respond.ok(
        {
          processed: 0,
          skipped: 0,
          reason: "PIPELINE_DISABLED",
          dryrun,
        },
        { correlationId },
      );
    }

    const url = new URL(request.url);
    const queryParams = reconcileQuerySchema.parse({
      limit: url.searchParams.get("limit") || undefined,
      maxRetries: url.searchParams.get("maxRetries") || undefined,
    });

    const maxRetries = Number.isFinite(queryParams.maxRetries)
      ? queryParams.maxRetries!
      : DEFAULT_MAX_RETRIES;
    const limit = Number.isFinite(queryParams.limit) ? queryParams.limit! : DEFAULT_LIMIT;

    const candidates = await listReconciliationCandidates({ maxRetries, limit });
    const now = Date.now();

    let processed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const retryCount = candidate.releaseRetryCount ?? 0;
      const eligible = shouldRetry(candidate.releaseLastAttemptAt, retryCount, now);
      if (!eligible) {
        skipped += 1;
        continue;
      }

      const holdIds = safeParseJsonArray(candidate.extractedHoldIds);
      const attemptIds = safeParseJsonArray(candidate.extractedAttemptIds);

      if (!candidate.orderId) {
        await updateWebhookEventRelease(candidate.eventKey, {
          releaseResults: [],
          releaseStatus: "SKIPPED",
          releaseReason: "ORDER_ID_MISSING",
          releaseRetryCount: retryCount,
          releaseLastError: "orderId missing",
          releaseLastAttemptAt: new Date(),
        });
        skipped += 1;
        continue;
      }

      await executeHoldRelease({
        eventKey: candidate.eventKey,
        orderId: candidate.orderId,
        normalizedStatus: candidate.normalizedStatus,
        holdIds,
        attemptIds,
        topic: candidate.topic,
        dryrun,
      });

      processed += 1;
    }

    return respond.ok(
      {
        processed,
        skipped,
        candidates: candidates.length,
        dryrun,
      },
      { correlationId },
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        maskPII({
          correlationId,
          message: "Reconcile holds error",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR),
      undefined,
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  } finally {
    await releaseReconcileLock(lockKey);
  }
};
