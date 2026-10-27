export type StepEntry = {
  step: string;
  ok: boolean;
  meta?: Record<string, unknown>;
  error?: string;
};

export class StepLogger {
  private steps: StepEntry[] = [];

  addOk(step: string, meta?: Record<string, unknown>): void {
    if (meta) {
      this.steps.push({ step, ok: true, meta });
      return;
    }
    this.steps.push({ step, ok: true });
  }

  addFail(step: string, error: unknown): void {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const errorCode =
      error && typeof error === "object" && typeof (error as any).code === "string"
        ? (error as any).code
        : undefined;
    const errorStage =
      error && typeof error === "object" && typeof (error as any).stage === "string"
        ? (error as any).stage
        : undefined;
    const errorReason =
      error && typeof error === "object" && typeof (error as any).reason === "string"
        ? (error as any).reason
        : undefined;
    const trimmedReason =
      errorReason && errorReason.length > 200
        ? `${errorReason.slice(0, 200)}...`
        : errorReason;
    const message =
      errorCode || errorStage
        ? `UploadError code=${errorCode ?? "unknown"} stage=${errorStage ?? "unknown"}`
        : baseMessage;
    const meta: Record<string, unknown> | undefined =
      errorCode || errorStage
        ? {
            ...(errorCode ? { errorCode } : {}),
            ...(errorStage ? { errorStage } : {}),
            ...(trimmedReason ? { errorReason: trimmedReason } : {}),
          }
        : undefined;
    this.steps.push({
      step,
      ok: false,
      error: message,
      ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }

  toResult(): StepEntry[] {
    return [...this.steps];
  }
}

export function wrapErrorWithSteps(
  error: unknown,
  steps: StepEntry[],
  extra?: Record<string, unknown>
): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  (wrapped as Error & { steps?: StepEntry[] }).steps = steps;
  if (extra) {
    Object.assign(wrapped as Record<string, unknown>, extra);
  }
  return wrapped;
}
