export type EnvelopeSuccess<T> = {
  ok: true;
  data: T;
  error: null;
  meta: { correlationId: string };
};

export type EnvelopeError = {
  ok: false;
  data: null;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: { correlationId: string };
};

export type Envelope<T> = EnvelopeSuccess<T> | EnvelopeError;

export class GkvAdminClientError extends Error {
  code: string;
  status: number;
  correlationId?: string;

  constructor(input: { message: string; code: string; status: number; correlationId?: string }) {
    super(input.message);
    this.name = "GkvAdminClientError";
    this.code = input.code;
    this.status = input.status;
    this.correlationId = input.correlationId;
  }
}

async function parseEnvelope<T>(response: Response): Promise<Envelope<T>> {
  const body = (await response.json()) as Envelope<T>;
  return body;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const envelope = await parseEnvelope<T>(response);
  if (!response.ok || !envelope.ok) {
    const errorMessage = envelope.ok
      ? `Request failed: ${response.status}`
      : envelope.error.message;
    const errorCode = envelope.ok ? "HTTP_ERROR" : envelope.error.code;
    const correlationId = envelope.meta?.correlationId;
    throw new GkvAdminClientError({
      message: errorMessage,
      code: errorCode,
      status: response.status,
      correlationId,
    });
  }
  return envelope.data;
}

export const gkvAdminClient = {
  get<T>(path: string): Promise<T> {
    return request<T>(path, { method: "GET" });
  },
  post<T, B = unknown>(path: string, body: B): Promise<T> {
    return request<T>(path, { method: "POST", body: JSON.stringify(body) });
  },
  put<T, B = unknown>(path: string, body: B): Promise<T> {
    return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  },
  delete<T, B = unknown>(path: string, body?: B): Promise<T> {
    return request<T>(path, {
      method: "DELETE",
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  },
};
