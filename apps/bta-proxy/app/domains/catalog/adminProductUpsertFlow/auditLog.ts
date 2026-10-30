import { logEvent } from "~/lib/logEvent";
import type { StepEntry } from "~/domains/catalog/adminProductUpsertFlow/stepLog";

type AuditLogInput = {
  intent: string;
  ok: boolean;
  durationMs: number;
  externalKey?: string;
  productId?: string;
  steps?: StepEntry[];
  shop?: string;
  userEmail?: string;
};

export function auditLog(input: AuditLogInput): void {
  const { steps, ...rest } = input;
  const stepsSummary = (steps || []).slice(0, 20).map((step) => ({
    step: step.step,
    ok: step.ok,
    ...(step.ok ? {} : { error: trimError(step.error) }),
    ...(step.ok || !step.meta ? {} : { meta: step.meta }),
  }));
  let failedStep: StepEntry | undefined;
  if (steps && steps.length > 0) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      if (!steps[i].ok) {
        failedStep = steps[i];
        break;
      }
    }
  }

  logEvent(
    "admin_product_upsert",
    {
      ...rest,
      stepsSummary,
      failedStep: failedStep?.step,
      failedError: trimError(failedStep?.error),
    },
    {
      shop: input.shop,
      severity: input.ok ? "info" : "warn",
    },
  );
}

function trimError(message?: string, limit = 300): string | undefined {
  if (!message) {
    return undefined;
  }
  if (message.length <= limit) {
    return message;
  }
  return `${message.slice(0, limit)}...`;
}
