export type AdminCouponStatus = "NONE" | "ACTIVE" | "EXPIRED" | "REVOKED" | "USED";

export function resolveAdminCouponStatus(params: {
  code: string | null;
  used?: boolean;
  revoked: boolean;
  expiresAtSec: number | null;
  nowSec: number;
}): AdminCouponStatus {
  if (!params.code) {
    return "NONE";
  }
  if (params.used) {
    return "USED";
  }
  if (params.revoked) {
    return "REVOKED";
  }
  if (params.expiresAtSec && params.nowSec > params.expiresAtSec) {
    return "EXPIRED";
  }
  return "ACTIVE";
}
