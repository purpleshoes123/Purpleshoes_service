import type { ZodIssue, ZodError } from "zod";

export enum ValidationErrorCode {
  REQUIRED = "REQUIRED",
  INVALID_TYPE = "INVALID_TYPE",
  INVALID_FORMAT = "INVALID_FORMAT",
  OUT_OF_RANGE = "OUT_OF_RANGE",
  DUPLICATE = "DUPLICATE",
  CUSTOM = "CUSTOM",
}

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  path?: string[];
}

const toPath = (issue: ZodIssue): string[] | undefined => {
  if (!issue.path || issue.path.length === 0) {
    return undefined;
  }
  return issue.path.map((segment) => String(segment));
};

const mapIssueCode = (issue: ZodIssue): ValidationErrorCode => {
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return ValidationErrorCode.REQUIRED;
  }
  if (issue.code === "invalid_string" || issue.code === "invalid_enum_value") {
    return ValidationErrorCode.INVALID_FORMAT;
  }
  if (issue.code === "too_small" || issue.code === "too_big") {
    return ValidationErrorCode.OUT_OF_RANGE;
  }
  if (issue.code === "custom") {
    return ValidationErrorCode.CUSTOM;
  }
  return ValidationErrorCode.INVALID_TYPE;
};

export const zodToValidationErrors = (error: ZodError): ValidationError[] =>
  error.issues.map((issue) => ({
    code: mapIssueCode(issue),
    message: issue.message,
    path: toPath(issue),
  }));
