import { maskPII } from "~/lib/masking";

export type LogSeverity = "debug" | "info" | "warn" | "error";

export function logEvent(
  eventName: string,
  payload: Record<string, unknown>,
  options?: {
    correlationId?: string;
    shop?: string;
    severity?: LogSeverity;
  }
): void {
  const severity = options?.severity || "info";

  if (
    severity === "debug" &&
    process.env.DEBUG_BOOKING !== "1" &&
    process.env.LOG_LEVEL !== "debug"
  ) {
    return;
  }

  const logPayload = maskPII({
    event: eventName,
    ...payload,
    ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
    ...(options?.shop ? { shop: options.shop } : {}),
  });

  const line = JSON.stringify(logPayload);

  switch (severity) {
    case "debug":
      console.debug(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
    default:
      console.log(line);
  }
}
