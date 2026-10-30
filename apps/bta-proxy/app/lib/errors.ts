/**
 * SSOT 8장: 에러코드 매핑
 * 모든 에러 코드와 HTTP 상태 코드는 여기에서 정의됩니다.
 */

export enum ErrorCode {
  AUTH_PROXY_SIGNATURE_INVALID = "AUTH_PROXY_SIGNATURE_INVALID",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  MAILER_INVALID_INPUT = "MAILER_INVALID_INPUT",
  MAILER_NOT_CONFIGURED = "MAILER_NOT_CONFIGURED",
  MAILER_RECAPTCHA_FAILED = "MAILER_RECAPTCHA_FAILED",
  MAILER_RECIPIENT_UNSUBSCRIBED = "MAILER_RECIPIENT_UNSUBSCRIBED",
  MAILER_RATE_LIMITED = "MAILER_RATE_LIMITED",
  MAILER_TEMPLATE_NOT_FOUND = "MAILER_TEMPLATE_NOT_FOUND",
  MAILER_TEMPLATE_INACTIVE = "MAILER_TEMPLATE_INACTIVE",
  MAILER_ATTACHMENT_INVALID = "MAILER_ATTACHMENT_INVALID",
  MAILER_PROVIDER_ERROR = "MAILER_PROVIDER_ERROR",
  MAILER_PROVIDER_TIMEOUT = "MAILER_PROVIDER_TIMEOUT",
  RATE_LIMITED = "RATE_LIMITED",
  BOOKING_NOT_AVAILABLE = "BOOKING_NOT_AVAILABLE",
  BOOKING_STORE_ERROR = "BOOKING_STORE_ERROR",
  BOOKING_STORE_TIMEOUT = "BOOKING_STORE_TIMEOUT",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  INTERNAL_CONFLICT = "INTERNAL_CONFLICT",
  AUTH_LOGIN_REQUIRED = "AUTH_LOGIN_REQUIRED",
  GKV_SESSION_REQUIRED = "GKV_SESSION_REQUIRED",
  GKV_SESSION_INACTIVE = "GKV_SESSION_INACTIVE",
  GKV_SESSION_LIMIT_EXCEEDED = "GKV_SESSION_LIMIT_EXCEEDED",
  FAVORITE_INVALID_TYPE = "FAVORITE_INVALID_TYPE",
  FAVORITE_INVALID_TARGET = "FAVORITE_INVALID_TARGET",
  FAVORITE_INVALID_CHANGE = "FAVORITE_INVALID_CHANGE",
  FAVORITE_BATCH_TOO_LARGE = "FAVORITE_BATCH_TOO_LARGE",
  FAVORITE_IDEMPOTENCY_CONFLICT = "FAVORITE_IDEMPOTENCY_CONFLICT",
  INSTAGRAM_AUTH_REQUIRED = "INSTAGRAM_AUTH_REQUIRED",
  INSTAGRAM_STATE_INVALID = "INSTAGRAM_STATE_INVALID",
  INSTAGRAM_STATE_EXPIRED = "INSTAGRAM_STATE_EXPIRED",
  INSTAGRAM_TOKEN_EXCHANGE_FAILED = "INSTAGRAM_TOKEN_EXCHANGE_FAILED",
  INSTAGRAM_TOKEN_EXPIRED = "INSTAGRAM_TOKEN_EXPIRED",
  INSTAGRAM_API_ERROR = "INSTAGRAM_API_ERROR",
  INSTAGRAM_DISCONNECTED = "INSTAGRAM_DISCONNECTED",
  // Phase 5-6R: Rebuild 관련 에러 코드
  INTERNAL_AUTH_INVALID = "INTERNAL_AUTH_INVALID",
  REBUILD_IN_PROGRESS = "REBUILD_IN_PROGRESS",
  SHOPIFY_ADMIN_API_ERROR = "SHOPIFY_ADMIN_API_ERROR",
  SHOPIFY_ADMIN_API_TIMEOUT = "SHOPIFY_ADMIN_API_TIMEOUT",
  // Guide Extension 전용 에러 코드
  GUIDE_EXTENSION_NOT_ELIGIBLE = "GUIDE_EXTENSION_NOT_ELIGIBLE",
  GUIDE_EXTENSION_EXPIRED = "GUIDE_EXTENSION_EXPIRED",
  GUIDE_EXTENSION_INVALID_INPUT = "GUIDE_EXTENSION_INVALID_INPUT",
  GUIDE_EXTENSION_CONFIG_ERROR = "GUIDE_EXTENSION_CONFIG_ERROR",
  // Review 전용 에러 코드
  REVIEW_INVALID_INPUT = "REVIEW_INVALID_INPUT",
  REVIEW_NOT_ELIGIBLE = "REVIEW_NOT_ELIGIBLE",
  REVIEW_DUPLICATE = "REVIEW_DUPLICATE",
  REVIEW_CONFLICT = "REVIEW_CONFLICT",
  REVIEW_SHOPIFY_API_ERROR = "REVIEW_SHOPIFY_API_ERROR",
  REVIEW_NOT_FOUND = "REVIEW_NOT_FOUND",
  REVIEW_QUERY_FAILED = "REVIEW_QUERY_FAILED",
}

/**
 * 에러 코드와 HTTP 상태 코드 매핑
 */
export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.AUTH_PROXY_SIGNATURE_INVALID]: 401,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.MAILER_INVALID_INPUT]: 400,
  [ErrorCode.MAILER_NOT_CONFIGURED]: 500,
  [ErrorCode.MAILER_RECAPTCHA_FAILED]: 403,
  [ErrorCode.MAILER_RECIPIENT_UNSUBSCRIBED]: 403,
  [ErrorCode.MAILER_RATE_LIMITED]: 429,
  [ErrorCode.MAILER_TEMPLATE_NOT_FOUND]: 404,
  [ErrorCode.MAILER_TEMPLATE_INACTIVE]: 409,
  [ErrorCode.MAILER_ATTACHMENT_INVALID]: 400,
  [ErrorCode.MAILER_PROVIDER_ERROR]: 502,
  [ErrorCode.MAILER_PROVIDER_TIMEOUT]: 504,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.BOOKING_NOT_AVAILABLE]: 409,
  [ErrorCode.BOOKING_STORE_ERROR]: 502,
  [ErrorCode.BOOKING_STORE_TIMEOUT]: 504,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.INTERNAL_CONFLICT]: 409,
  [ErrorCode.AUTH_LOGIN_REQUIRED]: 403,
  [ErrorCode.GKV_SESSION_REQUIRED]: 409,
  [ErrorCode.GKV_SESSION_INACTIVE]: 409,
  [ErrorCode.GKV_SESSION_LIMIT_EXCEEDED]: 409,
  [ErrorCode.FAVORITE_INVALID_TYPE]: 400,
  [ErrorCode.FAVORITE_INVALID_TARGET]: 400,
  [ErrorCode.FAVORITE_INVALID_CHANGE]: 400,
  [ErrorCode.FAVORITE_BATCH_TOO_LARGE]: 400,
  [ErrorCode.FAVORITE_IDEMPOTENCY_CONFLICT]: 400,
  [ErrorCode.INSTAGRAM_AUTH_REQUIRED]: 403,
  [ErrorCode.INSTAGRAM_STATE_INVALID]: 400,
  [ErrorCode.INSTAGRAM_STATE_EXPIRED]: 400,
  [ErrorCode.INSTAGRAM_TOKEN_EXCHANGE_FAILED]: 502,
  [ErrorCode.INSTAGRAM_TOKEN_EXPIRED]: 401,
  [ErrorCode.INSTAGRAM_API_ERROR]: 502,
  [ErrorCode.INSTAGRAM_DISCONNECTED]: 403,
  // Phase 5-6R: Rebuild 관련 에러 코드
  [ErrorCode.INTERNAL_AUTH_INVALID]: 401,
  [ErrorCode.REBUILD_IN_PROGRESS]: 409,
  [ErrorCode.SHOPIFY_ADMIN_API_ERROR]: 502,
  [ErrorCode.SHOPIFY_ADMIN_API_TIMEOUT]: 504,
  // Guide Extension 전용 상태코드
  [ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE]: 403,
  [ErrorCode.GUIDE_EXTENSION_EXPIRED]: 409,
  [ErrorCode.GUIDE_EXTENSION_INVALID_INPUT]: 400,
  [ErrorCode.GUIDE_EXTENSION_CONFIG_ERROR]: 500,
  // Review 전용 상태코드
  [ErrorCode.REVIEW_INVALID_INPUT]: 400,
  [ErrorCode.REVIEW_NOT_ELIGIBLE]: 403,
  [ErrorCode.REVIEW_DUPLICATE]: 409,
  [ErrorCode.REVIEW_CONFLICT]: 409,
  [ErrorCode.REVIEW_SHOPIFY_API_ERROR]: 502,
  [ErrorCode.REVIEW_NOT_FOUND]: 404,
  [ErrorCode.REVIEW_QUERY_FAILED]: 500,
};

/**
 * 에러 코드에 해당하는 HTTP 상태 코드를 반환합니다.
 */
export function getErrorStatus(errorCode: ErrorCode): number {
  return ERROR_STATUS_MAP[errorCode];
}

/**
 * 에러 메시지를 생성합니다.
 */
export function getErrorMessage(errorCode: ErrorCode, details?: string): string {
  const messages: Record<ErrorCode, string> = {
    [ErrorCode.AUTH_PROXY_SIGNATURE_INVALID]: "App Proxy 서명 검증에 실패했습니다.",
    [ErrorCode.VALIDATION_ERROR]: details || "입력 값 검증에 실패했습니다.",
    [ErrorCode.MAILER_INVALID_INPUT]: details || "메일 요청 입력 값이 올바르지 않습니다.",
    [ErrorCode.MAILER_NOT_CONFIGURED]: "메일러 설정이 올바르지 않습니다. 관리자에게 문의해주세요.",
    [ErrorCode.MAILER_RECAPTCHA_FAILED]: "요청을 처리할 수 없습니다.",
    [ErrorCode.MAILER_RECIPIENT_UNSUBSCRIBED]: "수신 거부된 이메일 주소입니다.",
    [ErrorCode.MAILER_RATE_LIMITED]: "요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.",
    [ErrorCode.MAILER_TEMPLATE_NOT_FOUND]: "요청을 처리할 수 없습니다.",
    [ErrorCode.MAILER_TEMPLATE_INACTIVE]: "현재 요청 가능한 메일 템플릿이 아닙니다.",
    [ErrorCode.MAILER_ATTACHMENT_INVALID]: "첨부파일 처리 중 오류가 발생했습니다.",
    [ErrorCode.MAILER_PROVIDER_ERROR]: "메일 발송 처리 중 오류가 발생했습니다.",
    [ErrorCode.MAILER_PROVIDER_TIMEOUT]: "메일 발송이 시간 초과되었습니다.",
    [ErrorCode.RATE_LIMITED]: "요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.",
    [ErrorCode.BOOKING_NOT_AVAILABLE]: "예약이 불가능한 상태입니다.",
    [ErrorCode.BOOKING_STORE_ERROR]: "Booking Store 호출 중 오류가 발생했습니다.",
    [ErrorCode.BOOKING_STORE_TIMEOUT]: "Booking Store 호출이 시간 초과되었습니다.",
    [ErrorCode.INTERNAL_ERROR]: "서버 내부 오류가 발생했습니다.",
    [ErrorCode.INTERNAL_CONFLICT]: "요청이 이미 처리 중입니다. 잠시 후 다시 시도해주세요.",
    [ErrorCode.AUTH_LOGIN_REQUIRED]: "로그인이 필요합니다.",
    [ErrorCode.GKV_SESSION_REQUIRED]: details || "활성화된 GKV 기기 세션이 필요합니다.",
    [ErrorCode.GKV_SESSION_INACTIVE]: details || "GKV 기기 세션이 만료되었거나 해제되었습니다.",
    [ErrorCode.GKV_SESSION_LIMIT_EXCEEDED]: details || "동시 로그인 제한을 초과했습니다.",
    [ErrorCode.FAVORITE_INVALID_TYPE]: details || "즐겨찾기 타입이 올바르지 않습니다.",
    [ErrorCode.FAVORITE_INVALID_TARGET]: details || "즐겨찾기 대상이 올바르지 않습니다.",
    [ErrorCode.FAVORITE_INVALID_CHANGE]: details || "즐겨찾기 변경 요청이 올바르지 않습니다.",
    [ErrorCode.FAVORITE_BATCH_TOO_LARGE]: details || "즐겨찾기 변경 요청 수가 너무 많습니다.",
    [ErrorCode.FAVORITE_IDEMPOTENCY_CONFLICT]:
      details || "이미 다른 내용으로 처리된 즐겨찾기 변경 요청입니다.",
    [ErrorCode.INSTAGRAM_AUTH_REQUIRED]: "Instagram 연결 인증이 필요합니다.",
    [ErrorCode.INSTAGRAM_STATE_INVALID]: "Instagram OAuth state 검증에 실패했습니다.",
    [ErrorCode.INSTAGRAM_STATE_EXPIRED]: "Instagram OAuth state가 만료되었습니다.",
    [ErrorCode.INSTAGRAM_TOKEN_EXCHANGE_FAILED]: "Instagram 토큰 교환에 실패했습니다.",
    [ErrorCode.INSTAGRAM_TOKEN_EXPIRED]: "Instagram 토큰이 만료되었습니다.",
    [ErrorCode.INSTAGRAM_API_ERROR]: "Instagram API 호출 중 오류가 발생했습니다.",
    [ErrorCode.INSTAGRAM_DISCONNECTED]: "Instagram 계정 연결이 해제되었습니다.",
    // Phase 5-6R: Rebuild 관련 에러 메시지
    [ErrorCode.INTERNAL_AUTH_INVALID]: "내부 토큰 인증에 실패했습니다.",
    [ErrorCode.REBUILD_IN_PROGRESS]: "Rebuild가 이미 진행 중입니다. 잠시 후 다시 시도해주세요.",
    [ErrorCode.SHOPIFY_ADMIN_API_ERROR]: "Shopify Admin API 호출 중 오류가 발생했습니다.",
    [ErrorCode.SHOPIFY_ADMIN_API_TIMEOUT]: "Shopify Admin API 호출이 시간 초과되었습니다.",
    [ErrorCode.GUIDE_EXTENSION_NOT_ELIGIBLE]: "연장 구매 대상이 아닙니다.",
    [ErrorCode.GUIDE_EXTENSION_EXPIRED]: "만료된 권리는 연장할 수 없습니다.",
    [ErrorCode.GUIDE_EXTENSION_INVALID_INPUT]: details || "연장 구매 입력 값이 올바르지 않습니다.",
    [ErrorCode.GUIDE_EXTENSION_CONFIG_ERROR]:
      "연장권 설정이 올바르지 않습니다. 관리자에게 문의해주세요.",
    [ErrorCode.REVIEW_INVALID_INPUT]: details || "리뷰 입력 값이 올바르지 않습니다.",
    [ErrorCode.REVIEW_NOT_ELIGIBLE]: "Verified purchases only.",
    [ErrorCode.REVIEW_DUPLICATE]: "Already submitted for this order.",
    [ErrorCode.REVIEW_CONFLICT]: "Please retry.",
    [ErrorCode.REVIEW_SHOPIFY_API_ERROR]: "Shopify Admin API 호출 중 오류가 발생했습니다.",
    [ErrorCode.REVIEW_NOT_FOUND]: "Review not found.",
    [ErrorCode.REVIEW_QUERY_FAILED]: "Review query failed.",
  };

  return messages[errorCode];
}
