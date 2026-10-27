import { respond } from "~/lib/respond";
import { getGkvEnv } from "~/lib/gkv/env";

export async function verifyGkvAdmin(request: Request): Promise<Response | null> {
  const correlationId = respond.getCorrelationId(request);
  const env = getGkvEnv();
  const expected = env.adminToken;

  if (!expected) {
    return respond.fail(
      "GKV_ADMIN_AUTH_DISABLED",
      "GKV_ADMIN_TOKEN이 설정되지 않아 /admin 기능이 비활성화되었습니다.",
      undefined,
      503,
      correlationId
    );
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const rawToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : authorization.trim();

  if (!rawToken || rawToken !== expected) {
    return respond.fail(
      "GKV_ADMIN_UNAUTHORIZED",
      "관리자 인증에 실패했습니다.",
      undefined,
      401,
      correlationId
    );
  }

  return null;
}
