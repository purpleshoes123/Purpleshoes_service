export type TourPercentCode = "TOUR5" | "TOUR15" | "TOUR20";
export type MediaConsentAdminOverride = "ALLOW" | "DENY";

export type CouponKind = "GUIDE50" | "EXTRA10" | TourPercentCode;

export type CouponCode = string;

export type CartLine = {
  productId?: string | number | null;
  variantId?: string | number | null;
  sku?: string | null;
  tags?: string[] | null;
  productType?: string | null;
  collections?: string[] | null;
};

export type CouponState = {
  webRegisteredAt?: number | null;
  webMemberTagSynced?: boolean;
  webRegistrationMailComplete?: boolean;
  webRegistrationKlaviyoComplete?: boolean;
  guide50RecoveryCode?: string | null;
  guide50RecoveryEvidence?: string | null;
  guide50RecoveryStartedAt?: number | null;
  guide50RecoveryCompleted?: boolean;
  guide50RegisteredAt?: number | null;
  guide50RegistrationIssued?: boolean;
  entitledTour15: boolean;
  tour15GuideBundleOrderIds: string[];
  tour15RevokedGuideBundleOrderIds: string[];
  tour15TourReviewActive: boolean;
  tour15AdminBlocked: boolean;
  tour15AdminBlockedAt: number | null;
  tour15AdminBlockedBy: string | null;
  tour15AdminBlockedReason: string | null;
  tour15AdminGrantedAt: number | null;
  tour15AdminGrantedBy: string | null;
  tour15AdminGrantedReason: string | null;
  tour15AdminRevokedAt: number | null;
  tour15AdminRevokedBy: string | null;
  tour15AdminRevokedReason: string | null;
  mediaConsent: boolean;
  mediaConsentAdminOverride: MediaConsentAdminOverride | null;
  mediaConsentAdminOverrideAt: number | null;
  mediaConsentAdminOverrideBy: string | null;
  mediaConsentAdminOverrideReason: string | null;
  guide50Code: string | null;
  guide50IssuedAt: number | null;
  guide50ExpiresAt: number | null;
  guide50DiscountId: string | null;
  guide50ConsumedCode: string | null;
  guide50ConsumedIssuedAt: number | null;
  guide50ConsumedExpiresAt: number | null;
  guide50ConsumedDiscountId: string | null;
  guide50ConsumedOrderId: string | null;
  guide50ConsumedAt: number | null;
  extra10Issued: boolean;
  extra10Code: string | null;
  extra10IssuedAt: number | null;
  extra10DiscountId: string | null;
  extra10ShareActivated: boolean;
  extra10ShareActivatedAt: number | null;
  tourCompletedAt: number | null;
  reviewCompletedAt: number | null;
};

export type SyncDecision = {
  tourPercentCode: TourPercentCode | null;
  containsExtension: boolean;
};

export type SyncRequest = {
  customerId?: string | null;
  cartId: string;
  mediaConsent: boolean;
  wantsExtra10: boolean;
  entitled15?: boolean | null;
  cartLines: CartLine[];
};

export type SyncResponse = {
  appliedCodes: string[];
  removedCodes: string[];
  addedCodes: string[];
  decision: SyncDecision;
  warnings?: string[];
  invalidCodes?: string[];
};

export type DiscountStatus = "valid" | "invalid" | "unknown";

export type DiscountStatusResult = {
  status: DiscountStatus;
  reason?: string;
  endsAt?: string | null;
  usageLimit?: number | null;
  usageCount?: number | null;
};
