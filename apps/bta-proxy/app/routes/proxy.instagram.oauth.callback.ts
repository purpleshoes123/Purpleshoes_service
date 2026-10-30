import { redirect, type LoaderFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  exchangeCodeForInstagramToken,
  exchangeLongLivedInstagramToken,
  fetchInstagramAccountProfile,
  InstagramClientError,
} from "~/domains/marketing/instagram/client";
import { ensureInstagramOAuthConfig, getInstagramConfig } from "~/domains/marketing/instagram/env";
import {
  consumeInstagramOAuthState,
  setInstagramSyncDebug,
} from "~/domains/marketing/instagram/store";
import { saveInstagramConnection } from "~/domains/marketing/instagram/service";

function appendQuery(path: string, params: Record<string, string>): string {
  const url = new URL(path, "https://localhost");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}`;
}

function toFailureCode(error: unknown): ErrorCode {
  if (error instanceof InstagramClientError) {
    return error.code;
  }
  return ErrorCode.INTERNAL_ERROR;
}

/**
 * GET /proxy/instagram/oauth/callback
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);

  const stateToken = (url.searchParams.get("state") || "").trim();
  if (!stateToken) {
    return respond.fail(
      ErrorCode.INSTAGRAM_STATE_INVALID,
      getErrorMessage(ErrorCode.INSTAGRAM_STATE_INVALID),
      undefined,
      getErrorStatus(ErrorCode.INSTAGRAM_STATE_INVALID),
      correlationId,
    );
  }

  const oauthState = await consumeInstagramOAuthState(stateToken);
  if (!oauthState) {
    return respond.fail(
      ErrorCode.INSTAGRAM_STATE_INVALID,
      getErrorMessage(ErrorCode.INSTAGRAM_STATE_INVALID),
      undefined,
      getErrorStatus(ErrorCode.INSTAGRAM_STATE_INVALID),
      correlationId,
    );
  }

  const returnTo = oauthState.returnTo;
  const oauthError = (url.searchParams.get("error") || "").trim();
  const oauthErrorReason = (url.searchParams.get("error_reason") || "").trim();
  const oauthErrorDescription = (url.searchParams.get("error_description") || "").trim();

  if (oauthError) {
    const message = [oauthError, oauthErrorReason, oauthErrorDescription]
      .filter(Boolean)
      .join(": ");

    await setInstagramSyncDebug({
      shop: oauthState.shop,
      debug: {
        lastSyncedAt: null,
        lastErrorCode: ErrorCode.INSTAGRAM_AUTH_REQUIRED,
        lastErrorAt: new Date().toISOString(),
        retryCount: 0,
      },
    });

    if (returnTo) {
      return redirect(
        appendQuery(returnTo, {
          instagram: "error",
          code: ErrorCode.INSTAGRAM_AUTH_REQUIRED,
        }),
        {
          headers: {
            "X-Correlation-Id": correlationId,
          },
        },
      );
    }

    return respond.fail(
      ErrorCode.INSTAGRAM_AUTH_REQUIRED,
      getErrorMessage(ErrorCode.INSTAGRAM_AUTH_REQUIRED, message || undefined),
      undefined,
      getErrorStatus(ErrorCode.INSTAGRAM_AUTH_REQUIRED),
      correlationId,
    );
  }

  const code = (url.searchParams.get("code") || "").trim();
  if (!code) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "code 파라미터가 필요합니다."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    const config = getInstagramConfig();
    ensureInstagramOAuthConfig(config);

    const shortToken = await exchangeCodeForInstagramToken(code);
    const longToken = await exchangeLongLivedInstagramToken(shortToken.accessToken);
    const profile = await fetchInstagramAccountProfile(longToken.accessToken);

    await saveInstagramConnection({
      shop: oauthState.shop,
      accessToken: longToken.accessToken,
      expiresIn: longToken.expiresIn,
      profile,
      scopes: config.oauthScopes
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    });

    await setInstagramSyncDebug({
      shop: oauthState.shop,
      debug: {
        lastSyncedAt: new Date().toISOString(),
        lastErrorCode: null,
        lastErrorAt: null,
        retryCount: 0,
      },
    });

    if (returnTo) {
      return redirect(
        appendQuery(returnTo, {
          instagram: "connected",
          shop: oauthState.shop,
        }),
        {
          headers: {
            "X-Correlation-Id": correlationId,
          },
        },
      );
    }

    return respond.ok(
      {
        connected: true,
        shop: oauthState.shop,
        instagramUsername: profile.instagramUsername,
        instagramUserId: profile.instagramUserId,
      },
      { correlationId },
    );
  } catch (error) {
    const codeValue = toFailureCode(error);
    const status = getErrorStatus(codeValue);

    await setInstagramSyncDebug({
      shop: oauthState.shop,
      debug: {
        lastSyncedAt: null,
        lastErrorCode: codeValue,
        lastErrorAt: new Date().toISOString(),
        retryCount: 1,
      },
    });

    if (returnTo) {
      return redirect(
        appendQuery(returnTo, {
          instagram: "error",
          code: codeValue,
        }),
        {
          headers: {
            "X-Correlation-Id": correlationId,
          },
        },
      );
    }

    return respond.fail(
      codeValue,
      getErrorMessage(codeValue, error instanceof Error ? error.message : undefined),
      error instanceof InstagramClientError ? error.details : undefined,
      status,
      correlationId,
    );
  }
};
