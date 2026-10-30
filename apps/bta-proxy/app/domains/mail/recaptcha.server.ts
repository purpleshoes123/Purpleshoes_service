import { z } from "zod";

const recaptchaResponseSchema = z.object({
  success: z.boolean().default(false),
  score: z.number().nullable().optional(),
  action: z.string().nullable().optional(),
  hostname: z.string().nullable().optional(),
  challenge_ts: z.string().nullable().optional(),
  "error-codes": z.array(z.string()).optional(),
});

export type VerifyRecaptchaTokenParams = {
  secretKey: string;
  token: string;
  expectedAction: string;
  threshold: number;
  remoteIp?: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type RecaptchaVerificationResult = {
  success: boolean;
  score: number | null;
  action: string | null;
  hostname: string | null;
  challengeTs: string | null;
  errorCodes: string[];
};

export async function verifyRecaptchaToken(
  params: VerifyRecaptchaTokenParams,
): Promise<RecaptchaVerificationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 5000);

  try {
    const body = new URLSearchParams({
      secret: params.secretKey,
      response: params.token,
    });

    if (params.remoteIp) {
      body.set("remoteip", params.remoteIp);
    }

    const response = await (params.fetchImpl || fetch)(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      throw new Error(`reCAPTCHA verify failed with ${response.status}`);
    }

    const raw = recaptchaResponseSchema.parse(await response.json());
    const action = raw.action || null;
    const score = raw.score ?? null;
    const success =
      raw.success &&
      action === params.expectedAction &&
      score !== null &&
      score >= params.threshold;

    return {
      success,
      score,
      action,
      hostname: raw.hostname || null,
      challengeTs: raw.challenge_ts || null,
      errorCodes: raw["error-codes"] || [],
    };
  } finally {
    clearTimeout(timeout);
  }
}
