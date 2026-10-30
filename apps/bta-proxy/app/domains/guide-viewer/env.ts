type GkvEnv = {
  enabled: boolean;
  strictMode: boolean;
  adminToken?: string;
};

function toBool(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * 신규 GKV 기능 전용 env 로더.
 * 기본값은 "비활성"이라 기존 /proxy 동작에 영향을 주지 않는다.
 */
export function getGkvEnv(): GkvEnv {
  const enabled = toBool(process.env.GKV_ENABLED, false);
  const strictMode = toBool(process.env.GKV_STRICT_MODE, false);
  const adminToken = process.env.GKV_ADMIN_TOKEN;

  return {
    enabled,
    strictMode,
    adminToken: adminToken && adminToken.length > 0 ? adminToken : undefined,
  };
}
