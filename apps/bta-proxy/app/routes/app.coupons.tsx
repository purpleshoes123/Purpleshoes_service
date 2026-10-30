import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useFetcher, useLoaderData, useSubmit } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  DataTable,
  InlineStack,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { getState, listRevoked } from "~/domains/coupons";
import { normalizeCode, normalizeCustomerId } from "~/domains/coupons/normalize";
import {
  assertAdminCustomerExists,
  parseAdminCustomerId,
} from "~/domains/coupons/adminCustomerValidation";
import { issueExtra10, issueGuide50, revokeCode } from "~/domains/coupons/issuer";
import { reconcileCustomerCoupons } from "~/domains/coupons/reconcile";
import {
  runAdminEligibilityControl,
  type AdminEligibilityAction,
} from "~/domains/coupons/adminEligibilityControls";
import { isMediaConsentAdminOverride } from "~/domains/coupons/effectiveEligibility";
import { resolveActiveExtra10 } from "~/domains/coupons/extra10Availability";
import { acquireLock, releaseLock } from "~/domains/coupons/lock";
import { fetchCustomerTourCreditBalance } from "~/domains/checkout/tourCredits/metafields";
import { getTourPending } from "~/domains/checkout/tourCheckout/pending";
import { resolveAdminCouponStatus, type AdminCouponStatus } from "~/domains/coupons/adminStatus";
import { respond } from "~/lib/respond";
import { ErrorCode, getErrorMessage, getErrorStatus } from "~/lib/errors";
import {
  formatCustomerSearchLabel,
  type CustomerSearchItem,
} from "~/domains/members/shopifyCustomerSearch";
import { searchCustomers } from "~/domains/members/shopifyCustomerSearch.server.ts";

const COUPON_KINDS = ["GUIDE50", "EXTRA10"] as const;
const ADMIN_ELIGIBILITY_ACTIONS = [
  "revoke_current_tour15",
  "grant_tour15_once",
  "block_tour15",
  "clear_tour15_block",
  "set_media_consent_override",
  "clear_media_consent_override",
] as const;

type CouponKind = (typeof COUPON_KINDS)[number];
type AdminEligibilityIntent = (typeof ADMIN_ELIGIBILITY_ACTIONS)[number];

type CouponItem = {
  kind: CouponKind;
  code: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  discountId: string | null;
  revoked: boolean;
  status: AdminCouponStatus;
};

type LoaderData = {
  customerError?: string;
  shop: string;
  host?: string | null;
  embedded?: string | null;
  customerId: string;
  items: CouponItem[];
  revoked: string[];
  flags: {
    entitledTour15: boolean;
    tour15GuideBundleOrderIds: string[];
    tour15TourReviewActive: boolean;
    tour15AdminBlocked: boolean;
    tour15AdminBlockedReason: string | null;
    mediaConsent: boolean;
    mediaConsentAdminOverride: string | null;
    mediaConsentAdminOverrideReason: string | null;
    tourCompletedAt: string | null;
    reviewCompletedAt: string | null;
  } | null;
  eligibility: {
    rawTour15CreditBalance: number | null;
    tour15CreditBalanceError: string | null;
    pendingTourCode: string | null;
    pendingTourKind: string | null;
    pendingTourDiscountId: string | null;
  } | null;
};

function normalizeEpochSeconds(value: number | null): number | null {
  if (!value) {
    return null;
  }
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
}

function formatEpoch(value: number | null): string | null {
  const seconds = normalizeEpochSeconds(value);
  if (!seconds) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function resolveStatusTone(
  status: CouponItem["status"],
): "success" | "warning" | "critical" | "attention" {
  if (status === "ACTIVE") {
    return "success";
  }
  if (status === "USED") {
    return "success";
  }
  if (status === "EXPIRED") {
    return "warning";
  }
  if (status === "REVOKED") {
    return "critical";
  }
  return "attention";
}

export function formatCouponStatusLabel(status: AdminCouponStatus): string {
  if (status === "ACTIVE") {
    return "사용 가능";
  }
  if (status === "USED") {
    return "사용 완료";
  }
  if (status === "EXPIRED") {
    return "만료";
  }
  if (status === "REVOKED") {
    return "회수됨";
  }
  return "없음";
}

function formatCouponKindLabel(kind: CouponKind): string {
  if (kind === "GUIDE50") {
    return "가이드킷 50%";
  }
  if (kind === "EXTRA10") {
    return "공유 $10";
  }
  return kind;
}

function formatRawBoolean(value: boolean): string {
  return value ? "true" : "false";
}

function formatDateTimeLabel(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

type DisplayTone = "success" | "warning" | "critical" | "attention";

export type Tour15DisplayState = {
  label: string;
  tone: DisplayTone;
  effectiveAvailable: boolean;
  rawEntitledLabel: string;
  rawCreditBalanceLabel: string;
  sourceLabel: string;
  blockedLabel: string;
  pendingDiscountLabel: string;
};

export function resolveTour15DisplayState(
  data: Pick<LoaderData, "flags" | "eligibility">,
): Tour15DisplayState {
  const flags = data.flags;
  const eligibility = data.eligibility;
  if (!flags || !eligibility) {
    return {
      label: "확인 전",
      tone: "attention",
      effectiveAvailable: false,
      rawEntitledLabel: "-",
      rawCreditBalanceLabel: "-",
      sourceLabel: "-",
      blockedLabel: "-",
      pendingDiscountLabel: "-",
    };
  }

  const rawCreditBalance = eligibility.rawTour15CreditBalance;
  const hasCredit = typeof rawCreditBalance === "number" && rawCreditBalance > 0;
  const effectiveAvailable = !flags.tour15AdminBlocked && (flags.entitledTour15 || hasCredit);
  const sourceParts: string[] = [];
  if (flags.tour15GuideBundleOrderIds.length) {
    sourceParts.push("가이드킷 번들");
  }
  if (flags.tour15TourReviewActive) {
    sourceParts.push("여행 리뷰");
  }
  if (!sourceParts.length && (flags.entitledTour15 || hasCredit)) {
    sourceParts.push("수동/legacy 상태");
  }
  const pendingDiscountLabel = eligibility.pendingTourCode
    ? `${eligibility.pendingTourKind || "-"} / ${eligibility.pendingTourCode}`
    : "-";

  return {
    label: flags.tour15AdminBlocked
      ? "관리자 차단"
      : effectiveAvailable
        ? "사용 가능"
        : "사용 불가",
    tone: flags.tour15AdminBlocked ? "critical" : effectiveAvailable ? "success" : "attention",
    effectiveAvailable,
    rawEntitledLabel: flags.entitledTour15 ? "있음" : "없음",
    rawCreditBalanceLabel:
      rawCreditBalance === null
        ? eligibility.tour15CreditBalanceError
          ? "확인 실패"
          : "-"
        : String(rawCreditBalance),
    sourceLabel: sourceParts.length ? sourceParts.join(", ") : "-",
    blockedLabel: flags.tour15AdminBlocked
      ? flags.tour15AdminBlockedReason
        ? `차단됨 (${flags.tour15AdminBlockedReason})`
        : "차단됨"
      : "없음",
    pendingDiscountLabel,
  };
}

export type MediaConsentDisplayState = {
  rawLabel: string;
  overrideLabel: string;
  effectiveLabel: string;
  tone: DisplayTone;
};

export function resolveMediaConsentDisplayState(
  data: Pick<LoaderData, "flags">,
): MediaConsentDisplayState {
  const flags = data.flags;
  if (!flags) {
    return {
      rawLabel: "-",
      overrideLabel: "-",
      effectiveLabel: "확인 전",
      tone: "attention",
    };
  }
  const override = flags.mediaConsentAdminOverride;
  const effective = override === "ALLOW" ? true : override === "DENY" ? false : flags.mediaConsent;

  return {
    rawLabel: flags.mediaConsent ? "동의함" : "동의 안 함",
    overrideLabel:
      override === "ALLOW" ? "사용 가능 강제" : override === "DENY" ? "사용 불가 강제" : "없음",
    effectiveLabel: effective ? "사용 가능" : "사용 불가",
    tone: effective ? "success" : "attention",
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  const hostParam = url.searchParams.get("host");
  const embeddedParam = url.searchParams.get("embedded");
  const rawCustomerId = url.searchParams.get("customerId") || "";
  let customerId = parseAdminCustomerId(rawCustomerId) || "";
  let customerError: string | undefined;
  if (rawCustomerId.trim()) {
    try {
      await assertAdminCustomerExists(auth.admin, customerId);
    } catch (error) {
      customerError = error instanceof Error ? error.message : "고객을 확인하지 못했습니다.";
      customerId = "";
    }
  }
  const shop = shopParam || auth.session.shop || "";

  if (!customerId) {
    return json<LoaderData>({
      shop,
      host: hostParam,
      embedded: embeddedParam,
      customerId: "",
      customerError,
      items: [],
      revoked: [],
      flags: null,
      eligibility: null,
    });
  }

  const state = await getState(customerId);
  const extra10Availability = await resolveActiveExtra10({
    admin: auth.admin,
    customerId,
    state,
  });
  const revokedList = await listRevoked(customerId);
  const pendingTour = await getTourPending(customerId);
  let rawTour15CreditBalance: number | null = null;
  let tour15CreditBalanceError: string | null = null;
  try {
    rawTour15CreditBalance = await fetchCustomerTourCreditBalance(auth.admin, customerId);
  } catch (error) {
    tour15CreditBalanceError = error instanceof Error ? error.message : String(error);
  }
  const revokedSet = new Set(
    Array.from(revokedList)
      .map((code) => normalizeCode(code))
      .filter((code): code is string => Boolean(code)),
  );
  const nowSec = Math.floor(Date.now() / 1000);

  const guide50Code = state.guide50Code || state.guide50ConsumedCode;
  const guide50IsUsed = Boolean(
    guide50Code &&
    state.guide50ConsumedCode &&
    normalizeCode(guide50Code) === normalizeCode(state.guide50ConsumedCode),
  );
  const guide50IssuedAt = state.guide50Code ? state.guide50IssuedAt : state.guide50ConsumedIssuedAt;
  const guide50ExpiresAt = state.guide50Code
    ? state.guide50ExpiresAt
    : state.guide50ConsumedExpiresAt;
  const guide50DiscountId = state.guide50Code
    ? state.guide50DiscountId
    : state.guide50ConsumedDiscountId;
  const guide50ExpiresAtSec = normalizeEpochSeconds(guide50ExpiresAt);
  const extra10Code = extra10Availability.available ? extra10Availability.code : null;
  const extra10ExpiresAtSec = null;

  const items: CouponItem[] = [
    {
      kind: "GUIDE50",
      code: guide50Code,
      issuedAt: formatEpoch(guide50IssuedAt),
      expiresAt: formatEpoch(guide50ExpiresAt),
      discountId: guide50DiscountId,
      revoked: guide50Code ? revokedSet.has(normalizeCode(guide50Code) || guide50Code) : false,
      status: "NONE",
    },
    {
      kind: "EXTRA10",
      code: extra10Code,
      issuedAt: extra10Code ? formatEpoch(state.extra10IssuedAt) : null,
      expiresAt: null,
      discountId: extra10Code ? state.extra10DiscountId : null,
      revoked:
        extra10Availability.reason === "REVOKED" ||
        extra10Availability.reason === "SHOPIFY_INVALID" ||
        (extra10Code ? revokedSet.has(normalizeCode(extra10Code) || extra10Code) : false),
      status: "NONE",
    },
  ];

  items[0].status = resolveAdminCouponStatus({
    code: items[0].code,
    used: guide50IsUsed,
    revoked: items[0].revoked,
    expiresAtSec: guide50ExpiresAtSec,
    nowSec,
  });
  items[1].status = resolveAdminCouponStatus({
    code: items[1].code,
    revoked: items[1].revoked,
    expiresAtSec: extra10ExpiresAtSec,
    nowSec,
  });

  return json<LoaderData>({
    shop,
    host: hostParam,
    embedded: embeddedParam,
    customerId,
    items,
    revoked: Array.from(revokedList).sort(),
    flags: {
      entitledTour15: state.entitledTour15,
      tour15GuideBundleOrderIds: state.tour15GuideBundleOrderIds,
      tour15TourReviewActive: state.tour15TourReviewActive,
      tour15AdminBlocked: state.tour15AdminBlocked,
      tour15AdminBlockedReason: state.tour15AdminBlockedReason,
      mediaConsent: state.mediaConsent,
      mediaConsentAdminOverride: state.mediaConsentAdminOverride,
      mediaConsentAdminOverrideReason: state.mediaConsentAdminOverrideReason,
      tourCompletedAt: formatEpoch(state.tourCompletedAt),
      reviewCompletedAt: formatEpoch(state.reviewCompletedAt),
    },
    eligibility: {
      rawTour15CreditBalance,
      tour15CreditBalanceError,
      pendingTourCode: pendingTour?.code || null,
      pendingTourKind: pendingTour?.kind || null,
      pendingTourDiscountId: pendingTour?.discountId || null,
    },
  });
};

function ensureCouponKind(value: string): CouponKind | null {
  const normalized = value.toUpperCase();
  return COUPON_KINDS.includes(normalized as CouponKind) ? (normalized as CouponKind) : null;
}

function isAdminEligibilityIntent(value: string): value is AdminEligibilityIntent {
  return ADMIN_ELIGIBILITY_ACTIONS.includes(value as AdminEligibilityIntent);
}

function resolveAdminActor(auth: Awaited<ReturnType<typeof authenticate.admin>>): string | null {
  const session = auth.session as any;
  return (
    session?.onlineAccessInfo?.associated_user?.email ||
    session?.onlineAccessInfo?.associated_user?.id ||
    session?.userId ||
    session?.id ||
    null
  );
}

function resolveStateCode(
  kind: CouponKind,
  state: Awaited<ReturnType<typeof getState>>,
): { code: string | null; discountId: string | null } {
  if (kind === "GUIDE50") {
    return { code: state.guide50Code, discountId: state.guide50DiscountId };
  }
  if (kind === "EXTRA10") {
    return { code: state.extra10Code, discountId: state.extra10DiscountId };
  }
  return { code: null, discountId: null };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);

  if (request.method.toUpperCase() !== "POST") {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "Unsupported method."),
      undefined,
      getErrorStatus(ErrorCode.VALIDATION_ERROR),
      correlationId,
    );
  }

  try {
    const auth = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = String(formData.get("intent") || "").trim();
    const rawCustomerId = String(formData.get("customerId") || "").trim();
    const customerId = parseAdminCustomerId(rawCustomerId);
    const shop = auth.session.shop;

    if (intent === "searchCustomer") {
      const query = String(formData.get("query") || "").trim();
      if (!query) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(ErrorCode.VALIDATION_ERROR, "검색어가 필요합니다."),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }

      const customers = await searchCustomers(auth.admin, query);
      return respond.ok(
        {
          action: "searchCustomer",
          customers,
        },
        { correlationId },
      );
    }

    if (!customerId) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "customerId is required."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    }

    try {
      await assertAdminCustomerExists(auth.admin, customerId);
    } catch (error) {
      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        error instanceof Error ? error.message : "고객을 확인하지 못했습니다.",
        undefined,
        400,
        correlationId,
      );
    }

    if (isAdminEligibilityIntent(intent)) {
      const reason = String(formData.get("reason") || "").trim();
      const force = String(formData.get("force") || "") === "true";
      const rawOverride = String(formData.get("mediaConsentOverride") || "").trim();

      if (intent === "set_media_consent_override" && !isMediaConsentAdminOverride(rawOverride)) {
        return respond.fail(
          ErrorCode.VALIDATION_ERROR,
          getErrorMessage(
            ErrorCode.VALIDATION_ERROR,
            "mediaConsentOverride must be ALLOW or DENY.",
          ),
          undefined,
          getErrorStatus(ErrorCode.VALIDATION_ERROR),
          correlationId,
        );
      }

      try {
        const result = await runAdminEligibilityControl({
          admin: auth.admin,
          shop,
          customerId,
          action: intent as AdminEligibilityAction,
          reason,
          force,
          actor: resolveAdminActor(auth),
          mediaConsentOverride: isMediaConsentAdminOverride(rawOverride) ? rawOverride : null,
          correlationId,
        });
        return respond.ok(
          {
            action: intent,
            result,
            shop,
          },
          { correlationId },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const knownMessages: Record<string, string> = {
          ADMIN_ELIGIBILITY_REASON_REQUIRED: "변경 사유가 필요합니다.",
          ADMIN_ELIGIBILITY_CUSTOMER_ID_REQUIRED: "customerId is required.",
          ADMIN_ELIGIBILITY_MEDIA_OVERRIDE_REQUIRED: "mediaConsentOverride must be ALLOW or DENY.",
          ADMIN_ELIGIBILITY_ACTIVE_SOURCE_PRESENT:
            "활성 TOUR15 source가 있어 기본 회수를 중단했습니다. 정말 제거해야 하면 force 옵션을 사용하세요.",
          ADMIN_ELIGIBILITY_LOCKED:
            "같은 고객의 eligibility 작업이 진행 중입니다. 잠시 후 다시 시도해주세요.",
        };
        if (knownMessages[message]) {
          const code =
            message === "ADMIN_ELIGIBILITY_LOCKED"
              ? ErrorCode.INTERNAL_CONFLICT
              : ErrorCode.VALIDATION_ERROR;
          return respond.fail(
            code,
            getErrorMessage(code, knownMessages[message]),
            undefined,
            getErrorStatus(code),
            correlationId,
          );
        }
        throw error;
      }
    }

    const lockName =
      intent === "issue"
        ? "adminIssue"
        : intent === "reissue"
          ? "adminReissue"
          : intent === "revoke"
            ? "adminRevoke"
            : intent === "reconcile"
              ? "adminReconcile"
              : "adminAction";

    const lockOk = await acquireLock(lockName, customerId, 20);
    if (!lockOk) {
      return respond.fail(
        ErrorCode.INTERNAL_CONFLICT,
        getErrorMessage(ErrorCode.INTERNAL_CONFLICT),
        undefined,
        getErrorStatus(ErrorCode.INTERNAL_CONFLICT),
        correlationId,
      );
    }

    try {
      if (intent === "issue") {
        const kind = ensureCouponKind(String(formData.get("couponKind") || ""));
        if (!kind) {
          return respond.fail(
            ErrorCode.VALIDATION_ERROR,
            getErrorMessage(ErrorCode.VALIDATION_ERROR, "couponKind is required."),
            undefined,
            getErrorStatus(ErrorCode.VALIDATION_ERROR),
            correlationId,
          );
        }

        const result =
          kind === "GUIDE50"
            ? await issueGuide50(auth.admin, customerId)
            : await issueExtra10(auth.admin, customerId);

        console.log(
          JSON.stringify({
            message: "Coupons admin issue",
            shop,
            customerId,
            couponKind: kind,
            code: result.code,
            discountId: result.discountId,
            issued: result.issued,
            reason: result.reason,
          }),
        );
        return respond.ok(
          {
            action: "issue",
            couponKind: kind,
            code: result.code,
            issued: result.issued,
            reason: result.reason,
            discountId: result.discountId,
            shop,
          },
          { correlationId },
        );
      }

      if (intent === "reissue") {
        const kind = ensureCouponKind(String(formData.get("couponKind") || ""));
        if (!kind) {
          return respond.fail(
            ErrorCode.VALIDATION_ERROR,
            getErrorMessage(ErrorCode.VALIDATION_ERROR, "couponKind is required."),
            undefined,
            getErrorStatus(ErrorCode.VALIDATION_ERROR),
            correlationId,
          );
        }

        const state = await getState(customerId);
        const resolved = resolveStateCode(kind, state);
        const oldCode = resolved.code;
        const oldDiscountId = resolved.discountId;

        if (oldCode) {
          await revokeCode(auth.admin, customerId, oldCode, oldDiscountId);
        }

        const result =
          kind === "GUIDE50"
            ? await issueGuide50(auth.admin, customerId, { force: true })
            : await issueExtra10(auth.admin, customerId, { force: true });

        console.log(
          JSON.stringify({
            message: "Coupons admin reissue",
            shop,
            customerId,
            couponKind: kind,
            oldCode,
            newCode: result.code,
            discountId: result.discountId,
            issued: result.issued,
            reason: result.reason,
          }),
        );
        return respond.ok(
          {
            action: "reissue",
            couponKind: kind,
            oldCode,
            newCode: result.code,
            issued: result.issued,
            reason: result.reason,
            discountId: result.discountId,
            shop,
          },
          { correlationId },
        );
      }

      if (intent === "revoke") {
        const kind = ensureCouponKind(String(formData.get("couponKind") || ""));
        if (!kind) {
          return respond.fail(
            ErrorCode.VALIDATION_ERROR,
            getErrorMessage(ErrorCode.VALIDATION_ERROR, "couponKind is required."),
            undefined,
            getErrorStatus(ErrorCode.VALIDATION_ERROR),
            correlationId,
          );
        }

        const rawCode = String(formData.get("code") || "").trim();
        let code = rawCode || null;
        let discountId: string | null = null;
        if (!code) {
          const state = await getState(customerId);
          const resolved = resolveStateCode(kind, state);
          code = resolved.code;
          discountId = resolved.discountId;
        }

        if (!code) {
          return respond.fail(
            ErrorCode.VALIDATION_ERROR,
            getErrorMessage(ErrorCode.VALIDATION_ERROR, "revoke code not found."),
            undefined,
            getErrorStatus(ErrorCode.VALIDATION_ERROR),
            correlationId,
          );
        }

        await revokeCode(auth.admin, customerId, code, discountId);

        console.log(
          JSON.stringify({
            message: "Coupons admin revoke",
            shop,
            customerId,
            couponKind: kind,
            revokedCode: code,
          }),
        );
        return respond.ok(
          {
            action: "revoke",
            couponKind: kind,
            revokedCode: code,
            shop,
          },
          { correlationId },
        );
      }

      if (intent === "reconcile") {
        const dryRun = String(formData.get("dryRun") || "true") === "true";
        const report = await reconcileCustomerCoupons(auth.admin, customerId, dryRun);

        console.log(
          JSON.stringify({
            message: "Coupons admin reconcile",
            shop,
            customerId,
            dryRun,
            reportSummary: {
              checkedCodes: report.checkedCodes?.length,
              invalidDetected: report.invalidDetected?.length,
              revokedCodes: report.revokedCodes?.length,
              warnings: report.warnings?.length,
            },
          }),
        );
        return respond.ok(
          {
            action: "reconcile",
            dryRun,
            report,
            shop,
          },
          { correlationId },
        );
      }

      return respond.fail(
        ErrorCode.VALIDATION_ERROR,
        getErrorMessage(ErrorCode.VALIDATION_ERROR, "Unknown action."),
        undefined,
        getErrorStatus(ErrorCode.VALIDATION_ERROR),
        correlationId,
      );
    } finally {
      await releaseLock(lockName, customerId);
    }
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "Coupons admin action failed",
        error: message,
        intent: typeof (request as any)?.formData === "function" ? undefined : undefined,
      }),
    );
    return respond.fail(
      ErrorCode.INTERNAL_ERROR,
      getErrorMessage(ErrorCode.INTERNAL_ERROR, message),
      { error: message },
      getErrorStatus(ErrorCode.INTERNAL_ERROR),
      correlationId,
    );
  }
};

export default function CouponsAdminPage() {
  const data = useLoaderData<LoaderData>();
  const submit = useSubmit();
  const actionFetcher = useFetcher<any>();
  const searchFetcher = useFetcher<any>();

  const [input, setInput] = useState(data.customerId || "");
  const [dryRun, setDryRun] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pickedCustomerLabel, setPickedCustomerLabel] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<CustomerSearchItem[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [eligibilityReason, setEligibilityReason] = useState("");
  const [forceTour15Revoke, setForceTour15Revoke] = useState(false);
  const normalizedInput = normalizeCustomerId(input.trim());
  const inputMatches =
    Boolean(normalizedInput) && Boolean(data.customerId) && normalizedInput === data.customerId;
  const actionCustomerId = data.customerId || normalizedInput || input.trim();
  const actionUrl = buildCouponsActionUrl({
    shop: data.shop,
    host: data.host,
    embedded: data.embedded,
  });

  const lastActionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!actionFetcher.data || actionFetcher.state !== "idle") {
      return;
    }
    const payload = actionFetcher.data as any;
    const fingerprint = JSON.stringify(payload?.data ?? payload?.error ?? payload);
    if (lastActionRef.current === fingerprint) {
      return;
    }
    lastActionRef.current = fingerprint;
    if (payload.ok) {
      setErrorMessage(null);
      setSuccessMessage(buildSuccessMessage(payload.data));
      const formData = new FormData();
      if (actionCustomerId) {
        formData.set("customerId", actionCustomerId);
      }
      submit(formData, { method: "get", action: actionUrl });
      return;
    }
    if (payload.error?.message) {
      setSuccessMessage(null);
      setErrorMessage(payload.error.message);
    }
  }, [actionFetcher.data, actionFetcher.state, actionCustomerId, actionUrl, submit]);

  useEffect(() => {
    if (!searchFetcher.data) {
      return;
    }
    const payload = searchFetcher.data as any;
    if (payload.ok) {
      setSearchError(null);
      setSearchResults(payload.data?.customers || []);
      return;
    }
    if (payload.error?.message) {
      setSearchResults([]);
      setSearchError(payload.error.message);
    }
  }, [searchFetcher.data]);

  const handleSearchCustomers = () => {
    setSearchError(null);
    if (!searchTerm.trim()) {
      setSearchError("검색어를 입력해주세요.");
      return;
    }
    setHasSearched(true);
    const formData = new FormData();
    formData.set("intent", "searchCustomer");
    formData.set("query", searchTerm.trim());
    searchFetcher.submit(formData, { method: "post", action: actionUrl });
  };

  const handlePickCustomer = (customer: CustomerSearchItem) => {
    const normalized = normalizeCustomerId(customer.id);
    setInput(normalized || customer.id);
    setPickedCustomerLabel(formatCustomerSearchLabel(customer));
    setSearchResults([]);
  };

  const searchRows = useMemo(() => {
    if (!searchResults.length) {
      return [];
    }
    return searchResults.map((customer) => {
      return [
        formatCustomerSearchLabel(customer) || "-",
        customer.email || "-",
        customer.id,
        <Button
          key={`${customer.id}-select`}
          size="micro"
          onClick={() => handlePickCustomer(customer)}
        >
          선택
        </Button>,
      ];
    });
  }, [searchResults]);

  const reconcileReport =
    actionFetcher.data?.ok && actionFetcher.data?.data?.action === "reconcile"
      ? actionFetcher.data?.data?.report
      : null;

  const reconcileRows = useMemo(() => {
    if (!reconcileReport) {
      return [];
    }
    return reconcileReport.invalidDetected.map((item: any) => [
      item.code,
      item.status || "-",
      item.reason || "-",
    ]);
  }, [reconcileReport]);

  const tour15Display = useMemo(() => resolveTour15DisplayState(data), [data]);
  const mediaConsentDisplay = useMemo(() => resolveMediaConsentDisplayState(data), [data]);
  const guide50Status = data.items.find((item) => item.kind === "GUIDE50")?.status || "NONE";
  const extra10Status = data.items.find((item) => item.kind === "EXTRA10")?.status || "NONE";

  const summaryRows = useMemo(() => {
    if (!data.customerId) {
      return [];
    }
    return [
      ["고객 ID", data.customerId],
      [
        "GUIDE50",
        <Badge key="summary-guide50" tone={resolveStatusTone(guide50Status)}>
          {formatCouponStatusLabel(guide50Status)}
        </Badge>,
      ],
      [
        "EXTRA10",
        <Badge key="summary-extra10" tone={resolveStatusTone(extra10Status)}>
          {formatCouponStatusLabel(extra10Status)}
        </Badge>,
      ],
      [
        "여행상품 15% 쿠폰",
        <Badge key="summary-tour15" tone={tour15Display.tone}>
          {tour15Display.label}
        </Badge>,
      ],
      [
        "미디어 동의 할인",
        <Badge key="summary-media-consent" tone={mediaConsentDisplay.tone}>
          {mediaConsentDisplay.effectiveLabel}
        </Badge>,
      ],
    ];
  }, [
    data.customerId,
    extra10Status,
    guide50Status,
    mediaConsentDisplay.effectiveLabel,
    mediaConsentDisplay.tone,
    tour15Display.label,
    tour15Display.tone,
  ]);

  const tour15Rows = useMemo(() => {
    if (!data.flags || !data.eligibility) {
      return [];
    }
    return [
      [
        "현재 상태",
        <Badge key="tour15-current" tone={tour15Display.tone}>
          {tour15Display.label}
        </Badge>,
      ],
      ["실제 적용", tour15Display.effectiveAvailable ? "사용 가능" : "사용 불가"],
      ["원본 권한", tour15Display.rawEntitledLabel],
      ["보유 크레딧", tour15Display.rawCreditBalanceLabel],
      ["관리자 차단", tour15Display.blockedLabel],
      ["발급 출처", tour15Display.sourceLabel],
      ["대기 중인 여행 쿠폰", tour15Display.pendingDiscountLabel],
    ];
  }, [data.eligibility, data.flags, tour15Display]);

  const mediaConsentRows = useMemo(() => {
    if (!data.flags) {
      return [];
    }
    return [
      ["원본 미디어 동의", mediaConsentDisplay.rawLabel],
      ["관리자 강제 설정", mediaConsentDisplay.overrideLabel],
      [
        "실제 적용",
        <Badge key="media-consent-effective" tone={mediaConsentDisplay.tone}>
          {mediaConsentDisplay.effectiveLabel}
        </Badge>,
      ],
    ];
  }, [data.flags, mediaConsentDisplay]);

  const detailRows = useMemo(() => {
    if (!data.flags || !data.eligibility) {
      return [];
    }
    return [
      ["entitledTour15", formatRawBoolean(data.flags.entitledTour15)],
      ["mediaConsent", formatRawBoolean(data.flags.mediaConsent)],
      ["tourCompletedAt", data.flags.tourCompletedAt || "-"],
      ["reviewCompletedAt", data.flags.reviewCompletedAt || "-"],
      ["rawTour15CreditBalance", data.eligibility.rawTour15CreditBalance ?? "-"],
      ["tour15CreditBalanceError", data.eligibility.tour15CreditBalanceError || "-"],
      [
        "tour15GuideBundleOrderIds",
        data.flags.tour15GuideBundleOrderIds.length
          ? data.flags.tour15GuideBundleOrderIds.join(", ")
          : "-",
      ],
      ["tour15TourReviewActive", data.flags.tour15TourReviewActive ? "true" : "false"],
      ["tour15AdminBlocked", data.flags.tour15AdminBlocked ? "true" : "false"],
      ["tour15AdminBlockedReason", data.flags.tour15AdminBlockedReason || "-"],
      ["mediaConsentAdminOverride", data.flags.mediaConsentAdminOverride || "-"],
      ["mediaConsentAdminOverrideReason", data.flags.mediaConsentAdminOverrideReason || "-"],
      [
        "pendingTourDiscount",
        data.eligibility.pendingTourCode
          ? `${data.eligibility.pendingTourKind || "-"} / ${
              data.eligibility.pendingTourCode
            } / ${data.eligibility.pendingTourDiscountId || "-"}`
          : "-",
      ],
    ];
  }, [data.eligibility, data.flags]);

  const eligibilityActionDisabled =
    actionFetcher.state !== "idle" || !inputMatches || !eligibilityReason.trim();

  return (
    <Page title="쿠폰 관리자">
      <TitleBar title="쿠폰 관리자" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="400">
            <Text variant="headingMd" as="h2">
              고객 검색
            </Text>
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="end">
                <TextField
                  label="이름 / 이메일 / 고객 ID"
                  placeholder="예: 홍길동, user@example.com, 8435408863326"
                  value={searchTerm}
                  onChange={(value) => setSearchTerm(value)}
                  autoComplete="off"
                />
                <Button
                  onClick={handleSearchCustomers}
                  loading={searchFetcher.state !== "idle"}
                  disabled={searchFetcher.state !== "idle"}
                >
                  검색
                </Button>
              </InlineStack>
              {searchError ? <Banner tone="critical">{searchError}</Banner> : null}
              {searchRows.length ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["고객", "이메일", "고객 ID", "선택"]}
                  rows={searchRows}
                />
              ) : hasSearched ? (
                <Text variant="bodySm" as="p" tone="subdued">
                  검색 결과가 없습니다.
                </Text>
              ) : null}
            </BlockStack>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                const formData = new FormData();
                formData.set("customerId", input);
                submit(formData, { method: "get", action: actionUrl });
              }}
            >
              <BlockStack gap="200">
                <Text variant="headingSm" as="h3">
                  고급: 고객 ID 직접 입력
                </Text>
                <TextField
                  label="고객 ID"
                  value={input}
                  onChange={(value) => setInput(value)}
                  autoComplete="off"
                />
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {pickedCustomerLabel
                      ? `선택된 고객: ${pickedCustomerLabel}`
                      : "아래 검색으로 고객을 선택할 수 있습니다."}
                  </Text>
                </InlineStack>
                <Button submit>고객 불러오기</Button>
              </BlockStack>
            </form>
          </BlockStack>
        </Card>

        {data.customerError ? <Banner tone="critical">{data.customerError}</Banner> : null}
        {errorMessage ? (
          <Banner tone="critical" onDismiss={() => setErrorMessage(null)}>
            {errorMessage}
          </Banner>
        ) : null}
        {successMessage ? (
          <Banner tone="success" onDismiss={() => setSuccessMessage(null)}>
            {successMessage}
          </Banner>
        ) : null}

        {summaryRows.length ? (
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">
                고객 쿠폰 요약
              </Text>
              <DataTable
                columnContentTypes={["text", "text"]}
                headings={["항목", "상태"]}
                rows={summaryRows}
              />
            </BlockStack>
          </Card>
        ) : null}

        {data.items.length ? (
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">
                  쿠폰 상태
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  고객 ID: {data.customerId}
                </Text>
              </InlineStack>
              <BlockStack gap="400">
                {data.items.map((item) => {
                  const disabled = actionFetcher.state !== "idle" || !inputMatches;
                  return (
                    <div
                      key={item.kind}
                      style={{
                        borderTop: "1px solid #e3e3e3",
                        paddingTop: "16px",
                      }}
                    >
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text variant="headingSm" as="h3">
                            {formatCouponKindLabel(item.kind)}
                          </Text>
                          <Badge tone={resolveStatusTone(item.status)}>
                            {formatCouponStatusLabel(item.status)}
                          </Badge>
                        </InlineStack>

                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(112px, 168px) minmax(0, 1fr)",
                            columnGap: "16px",
                            rowGap: "10px",
                          }}
                        >
                          <Text as="span" variant="bodySm" tone="subdued">
                            쿠폰 코드
                          </Text>
                          <Text as="span" variant="bodySm">
                            <span
                              style={{
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}
                            >
                              {item.code || "-"}
                            </span>
                          </Text>

                          <Text as="span" variant="bodySm" tone="subdued">
                            발급일
                          </Text>
                          <Text as="span" variant="bodySm">
                            {formatDateTimeLabel(item.issuedAt)}
                          </Text>

                          <Text as="span" variant="bodySm" tone="subdued">
                            만료일
                          </Text>
                          <Text as="span" variant="bodySm">
                            {formatDateTimeLabel(item.expiresAt)}
                          </Text>

                          <Text as="span" variant="bodySm" tone="subdued">
                            Shopify 할인 ID
                          </Text>
                          <Text as="span" variant="bodySm">
                            <span
                              style={{
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}
                            >
                              {item.discountId || "-"}
                            </span>
                          </Text>
                        </div>

                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "8px",
                          }}
                        >
                          <Button
                            size="micro"
                            disabled={disabled}
                            onClick={() =>
                              submitAction(actionFetcher, {
                                intent: "issue",
                                customerId: actionCustomerId,
                                couponKind: item.kind,
                                shop: data.shop,
                                host: data.host,
                                embedded: data.embedded,
                              })
                            }
                          >
                            발급
                          </Button>
                          <Button
                            size="micro"
                            disabled={disabled}
                            onClick={() =>
                              submitAction(actionFetcher, {
                                intent: "reissue",
                                customerId: actionCustomerId,
                                couponKind: item.kind,
                                shop: data.shop,
                                host: data.host,
                                embedded: data.embedded,
                              })
                            }
                          >
                            재발급
                          </Button>
                          <Button
                            size="micro"
                            tone="critical"
                            disabled={disabled || !item.code}
                            onClick={() =>
                              submitAction(actionFetcher, {
                                intent: "revoke",
                                customerId: actionCustomerId,
                                couponKind: item.kind,
                                code: item.code || undefined,
                                shop: data.shop,
                                host: data.host,
                                embedded: data.embedded,
                              })
                            }
                          >
                            회수
                          </Button>
                        </div>
                      </BlockStack>
                    </div>
                  );
                })}
              </BlockStack>
            </BlockStack>
          </Card>
        ) : null}

        {data.flags ? (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                권한 관리
              </Text>
              <BlockStack gap="200">
                <Text variant="bodySm" as="p" tone="subdued">
                  아래 TOUR15 권한 관리와 미디어 동의 할인 관리 작업에 공통으로 기록될 변경 사유를
                  입력하세요.
                </Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  변경 사유를 입력해야 아래 관리 버튼을 실행할 수 있습니다.
                </Text>
                <TextField
                  label="공통 변경 사유"
                  placeholder="예: legacy 환불 처리로 TOUR15 권한 수동 회수"
                  value={eligibilityReason}
                  onChange={(value) => setEligibilityReason(value)}
                  autoComplete="off"
                  multiline={2}
                />
              </BlockStack>

              {data.eligibility ? (
                <BlockStack gap="300">
                  <Text variant="headingSm" as="h3">
                    여행상품 15% 쿠폰 권한 관리
                  </Text>
                  <Text variant="bodySm" as="p" tone="subdued">
                    회수/차단 작업은 고객의 여행상품 쿠폰 사용 가능 여부에 즉시 반영됩니다.
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text"]}
                    headings={["항목", "값"]}
                    rows={tour15Rows}
                  />
                  <Checkbox
                    label="활성 출처가 있어도 강제로 회수"
                    checked={forceTour15Revoke}
                    onChange={(value) => setForceTour15Revoke(value)}
                  />
                  <InlineStack gap="200">
                    <Button
                      tone="critical"
                      disabled={eligibilityActionDisabled}
                      onClick={() =>
                        submitAction(actionFetcher, {
                          intent: "revoke_current_tour15",
                          customerId: actionCustomerId,
                          reason: eligibilityReason,
                          force: forceTour15Revoke,
                          shop: data.shop,
                          host: data.host,
                          embedded: data.embedded,
                        })
                      }
                    >
                      현재 TOUR15 권한 회수
                    </Button>
                    <Button
                      disabled={eligibilityActionDisabled}
                      onClick={() =>
                        submitAction(actionFetcher, {
                          intent: "grant_tour15_once",
                          customerId: actionCustomerId,
                          reason: eligibilityReason,
                          shop: data.shop,
                          host: data.host,
                          embedded: data.embedded,
                        })
                      }
                    >
                      TOUR15 1회 지급
                    </Button>
                    <Button
                      tone="critical"
                      disabled={eligibilityActionDisabled}
                      onClick={() =>
                        submitAction(actionFetcher, {
                          intent: "block_tour15",
                          customerId: actionCustomerId,
                          reason: eligibilityReason,
                          shop: data.shop,
                          host: data.host,
                          embedded: data.embedded,
                        })
                      }
                    >
                      TOUR15 사용 차단
                    </Button>
                    <Button
                      disabled={eligibilityActionDisabled}
                      onClick={() =>
                        submitAction(actionFetcher, {
                          intent: "clear_tour15_block",
                          customerId: actionCustomerId,
                          reason: eligibilityReason,
                          shop: data.shop,
                          host: data.host,
                          embedded: data.embedded,
                        })
                      }
                    >
                      TOUR15 차단 해제
                    </Button>
                  </InlineStack>
                </BlockStack>
              ) : null}

              <BlockStack gap="300">
                <Text variant="headingSm" as="h3">
                  미디어 동의 할인 관리
                </Text>
                <Text variant="bodySm" as="p" tone="subdued">
                  관리자 설정이 있으면 고객의 원본 미디어 동의 값보다 우선 적용됩니다.
                </Text>
                <DataTable
                  columnContentTypes={["text", "text"]}
                  headings={["항목", "값"]}
                  rows={mediaConsentRows}
                />
                <InlineStack gap="200">
                  <Button
                    disabled={eligibilityActionDisabled}
                    onClick={() =>
                      submitAction(actionFetcher, {
                        intent: "set_media_consent_override",
                        customerId: actionCustomerId,
                        reason: eligibilityReason,
                        mediaConsentOverride: "ALLOW",
                        shop: data.shop,
                        host: data.host,
                        embedded: data.embedded,
                      })
                    }
                  >
                    미디어 동의 사용 가능 처리
                  </Button>
                  <Button
                    tone="critical"
                    disabled={eligibilityActionDisabled}
                    onClick={() =>
                      submitAction(actionFetcher, {
                        intent: "set_media_consent_override",
                        customerId: actionCustomerId,
                        reason: eligibilityReason,
                        mediaConsentOverride: "DENY",
                        shop: data.shop,
                        host: data.host,
                        embedded: data.embedded,
                      })
                    }
                  >
                    미디어 동의 사용 불가 처리
                  </Button>
                  <Button
                    disabled={eligibilityActionDisabled}
                    onClick={() =>
                      submitAction(actionFetcher, {
                        intent: "clear_media_consent_override",
                        customerId: actionCustomerId,
                        reason: eligibilityReason,
                        shop: data.shop,
                        host: data.host,
                        embedded: data.embedded,
                      })
                    }
                  >
                    관리자 설정 해제
                  </Button>
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        ) : null}

        {data.flags && data.eligibility ? (
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                상세 상태
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                운영 확인용 원시 상태입니다. 일반 조치는 위 권한 관리 영역에서 실행하세요.
              </Text>
              <DataTable
                columnContentTypes={["text", "text"]}
                headings={["필드", "값"]}
                rows={detailRows}
              />
            </BlockStack>
          </Card>
        ) : null}

        {data.revoked.length ? (
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                회수된 쿠폰
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                회수 이력이 있는 쿠폰 코드입니다.
              </Text>
              <Text variant="bodySm" as="p">
                {data.revoked.join(", ")}
              </Text>
            </BlockStack>
          </Card>
        ) : null}

        {data.customerId ? (
          <Card>
            <BlockStack gap="200">
              <Text variant="headingMd" as="h2">
                Shopify 정합성 점검
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                Shopify에서 이미 무효화되었거나 사용할 수 없는 쿠폰을 확인하고 내부 상태를
                정리합니다. 기본값은 실제 변경 없는 점검입니다.
              </Text>
              <Checkbox
                label="점검만 수행"
                checked={dryRun}
                onChange={(value) => setDryRun(value)}
              />
              <InlineStack gap="200">
                <Button
                  disabled={actionFetcher.state !== "idle" || !inputMatches}
                  onClick={() =>
                    submitAction(actionFetcher, {
                      intent: "reconcile",
                      customerId: actionCustomerId,
                      dryRun,
                      shop: data.shop,
                      host: data.host,
                      embedded: data.embedded,
                    })
                  }
                >
                  정합성 점검 실행
                </Button>
              </InlineStack>

              {reconcileReport ? (
                <BlockStack gap="200">
                  <Text variant="headingSm" as="h3">
                    정합성 점검 결과
                  </Text>
                  <DataTable
                    columnContentTypes={["text", "text", "text"]}
                    headings={["쿠폰 코드", "상태", "사유"]}
                    rows={reconcileRows}
                  />
                  {reconcileReport.warnings?.length ? (
                    <Banner tone="warning">{reconcileReport.warnings.join(" | ")}</Banner>
                  ) : null}
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}

type SubmitActionParams = {
  intent: "issue" | "reissue" | "revoke" | "reconcile" | AdminEligibilityIntent;
  customerId: string;
  shop?: string;
  host?: string | null;
  embedded?: string | null;
  couponKind?: CouponKind;
  code?: string;
  dryRun?: boolean;
  reason?: string;
  force?: boolean;
  mediaConsentOverride?: "ALLOW" | "DENY";
};

function submitAction(fetcher: ReturnType<typeof useFetcher>, params: SubmitActionParams) {
  const formData = new FormData();
  formData.set("intent", params.intent);
  formData.set("customerId", params.customerId);
  if (params.couponKind) {
    formData.set("couponKind", params.couponKind);
  }
  if (params.code) {
    formData.set("code", params.code);
  }
  if (params.intent === "reconcile") {
    formData.set("dryRun", params.dryRun ? "true" : "false");
  }
  if (params.reason) {
    formData.set("reason", params.reason);
  }
  if (params.force) {
    formData.set("force", "true");
  }
  if (params.mediaConsentOverride) {
    formData.set("mediaConsentOverride", params.mediaConsentOverride);
  }
  const action = buildCouponsActionUrl({
    shop: params.shop || "",
    host: params.host,
    embedded: params.embedded,
  });
  fetcher.submit(formData, { method: "post", action });
}

function buildCouponsActionUrl(params: {
  shop?: string;
  host?: string | null;
  embedded?: string | null;
}): string {
  const query = new URLSearchParams();
  if (params.shop) {
    query.set("shop", params.shop);
  }
  if (params.host) {
    query.set("host", params.host);
  }
  if (params.embedded) {
    query.set("embedded", params.embedded);
  }
  const qs = query.toString();
  return qs ? `/app/coupons?${qs}` : "/app/coupons";
}

function buildSuccessMessage(data: any): string {
  if (!data || typeof data !== "object") {
    return "작업이 완료되었습니다.";
  }
  if (data.action === "issue") {
    const suffix = data.issued ? "발급 완료" : data.reason || "처리 생략";
    return `${data.couponKind} ${suffix}. 코드: ${data.code || "-"}`;
  }
  if (data.action === "reissue") {
    return `${data.couponKind} 재발급 완료. 기존: ${
      data.oldCode || "-"
    } 새 코드: ${data.newCode || "-"}`;
  }
  if (data.action === "revoke") {
    return `${data.couponKind} 회수 완료. 코드: ${data.revokedCode || "-"}`;
  }
  if (data.action === "reconcile") {
    return `정합성 점검 완료. 점검만 수행: ${data.dryRun ? "예" : "아니오"}`;
  }
  if (isAdminEligibilityIntent(data.action)) {
    const warnings = data.result?.warnings?.length
      ? ` 경고: ${data.result.warnings.join(" | ")}`
      : "";
    return `권한 관리 작업이 완료되었습니다: ${data.action}.${warnings}`;
  }
  return "작업이 완료되었습니다.";
}
