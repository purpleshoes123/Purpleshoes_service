import { ZodError } from "zod";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import { respond } from "~/lib/respond";
import { zodToFieldErrors } from "~/lib/gkv/adminUiSchemas";

export function parseQueryBoolean(raw: string | null | undefined): boolean | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return undefined;
}

export function parseQueryInt(
  raw: string | null | undefined,
  options: { min?: number; max?: number; fallback: number }
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return options.fallback;
  if (options.min !== undefined && parsed < options.min) return options.fallback;
  if (options.max !== undefined && parsed > options.max) return options.fallback;
  return parsed;
}

export function parseCsv(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

export function toValidationFailResponse(request: Request, error: ZodError) {
  const correlationId = respond.getCorrelationId(request);
  return respond.fail(
    ErrorCode.VALIDATION_ERROR,
    getErrorMessage(ErrorCode.VALIDATION_ERROR, "Validation failed"),
    {
      fieldErrors: zodToFieldErrors(error),
    },
    422,
    correlationId
  );
}

export function isZodError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}
