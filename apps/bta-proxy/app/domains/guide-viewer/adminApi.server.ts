import { getGkvEnv } from "~/domains/guide-viewer/env";
import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";

type EnvelopeSuccess<T> = {
  ok: true;
  data: T;
  error: null;
  meta: { correlationId: string };
};

type EnvelopeError = {
  ok: false;
  data: null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: { correlationId: string };
};

type Envelope<T> = EnvelopeSuccess<T> | EnvelopeError;

export class GkvAdminApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;

  constructor(message: string, status: number, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GkvAdminApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function parseOriginFromEnv(value: string | undefined): string | null {
  if (!value || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function resolveInternalBaseOrigin(): string {
  const explicitOrigin = parseOriginFromEnv(process.env.GKV_ADMIN_INTERNAL_ORIGIN);
  if (explicitOrigin) {
    return explicitOrigin;
  }

  const port = process.env.PORT?.trim();
  if (port && /^\d+$/.test(port)) {
    return `http://127.0.0.1:${port}`;
  }

  // Never forward the privileged token to a client-controlled Host header.
  const appOrigin = parseOriginFromEnv(process.env.SHOPIFY_APP_URL);
  if (appOrigin) {
    return appOrigin;
  }
  throw new GkvAdminApiError(
    "Internal admin origin is not configured",
    503,
    "ADMIN_API_ORIGIN_MISSING",
  );
}

export async function callGkvAdminApi<T>(
  request: Request,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  await requireGkvAdmin(request);
  const env = getGkvEnv();
  if (!env.adminToken) {
    throw new GkvAdminApiError(
      "GKV_ADMIN_TOKEN이 설정되지 않았습니다.",
      503,
      "GKV_ADMIN_AUTH_DISABLED",
    );
  }

  const origin = resolveInternalBaseOrigin();
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/admin/")) {
    throw new GkvAdminApiError("Invalid internal admin path", 400, "ADMIN_API_INVALID_PATH");
  }
  const cookie = request.headers.get("Cookie");
  const headers = new Headers(init.headers ?? {});
  headers.set("Accept", "application/json");
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Authorization", `Bearer ${env.adminToken}`);
  if (cookie && !headers.has("Cookie")) {
    headers.set("Cookie", cookie);
  }

  let targetUrl = url.toString();
  let response: Response | null = null;
  let lastRedirectLocation: string | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(targetUrl, {
      ...init,
      redirect: "manual",
      headers,
    });

    if (response.status < 300 || response.status >= 400) {
      break;
    }

    const location = response.headers.get("Location") ?? response.headers.get("location");
    if (!location) {
      throw new GkvAdminApiError(
        `관리 API가 location 없는 리다이렉트 응답을 반환했습니다. (${response.status})`,
        502,
        "ADMIN_API_REDIRECT_MISSING_LOCATION",
      );
    }

    lastRedirectLocation = location;
    const redirectUrl = new URL(location, targetUrl);
    if (redirectUrl.origin !== origin) {
      throw new GkvAdminApiError(
        "Cross-origin admin redirect blocked",
        502,
        "ADMIN_API_UNSAFE_REDIRECT",
      );
    }
    targetUrl = redirectUrl.toString();
  }

  if (!response) {
    throw new GkvAdminApiError("관리 API 응답을 받지 못했습니다.", 502, "ADMIN_API_NO_RESPONSE");
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GkvAdminApiError(
      `관리 API가 리다이렉트 응답을 반환했습니다. (${response.status})`,
      502,
      "ADMIN_API_REDIRECT",
      { location: lastRedirectLocation },
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    const bodyPreview = (await response.text()).slice(0, 300);
    throw new GkvAdminApiError(
      "관리 API 응답이 JSON이 아닙니다.",
      response.status || 500,
      "ADMIN_API_NON_JSON",
      { contentType, bodyPreview },
    );
  }

  let envelope: Envelope<T>;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 파싱 실패";
    throw new GkvAdminApiError(
      `관리 API JSON 파싱에 실패했습니다. (${message})`,
      response.status || 500,
      "ADMIN_API_INVALID_JSON",
    );
  }

  if (!response.ok || !envelope.ok) {
    if (envelope.ok) {
      throw new GkvAdminApiError("관리 API 요청에 실패했습니다.", response.status, "HTTP_ERROR");
    }
    throw new GkvAdminApiError(
      envelope.error.message,
      response.status || 500,
      envelope.error.code || "ADMIN_API_ERROR",
      envelope.error.details,
    );
  }

  return envelope.data;
}
