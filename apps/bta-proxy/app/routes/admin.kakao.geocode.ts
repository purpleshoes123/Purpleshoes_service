import type { LoaderFunctionArgs } from "react-router";
import { ErrorCode, getErrorMessage } from "~/lib/errors";
import { geocodeAddress } from "~/domains/guide-viewer/kakao.server.ts";
import { respond } from "~/lib/respond";
import { verifyGkvAdmin } from "~/middleware/verifyGkvAdmin";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authFail = await verifyGkvAdmin(request);
  if (authFail) {
    return authFail;
  }

  const correlationId = respond.getCorrelationId(request);
  const url = new URL(request.url);
  const address = url.searchParams.get("address")?.trim();

  if (!address) {
    return respond.fail(
      ErrorCode.VALIDATION_ERROR,
      getErrorMessage(ErrorCode.VALIDATION_ERROR, "address 쿼리가 필요합니다."),
      { fieldErrors: { address: "주소를 입력해 주세요." } },
      422,
      correlationId,
    );
  }

  try {
    const data = await geocodeAddress(address);
    return respond.ok(data, { correlationId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : getErrorMessage(ErrorCode.INTERNAL_ERROR);
    return respond.fail(ErrorCode.INTERNAL_ERROR, message, undefined, 500, correlationId);
  }
};
