import type { LoaderFunctionArgs } from "react-router";
import { respond } from "~/lib/respond";
import { getGkvEnv } from "~/domains/guide-viewer/env";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const correlationId = respond.getCorrelationId(request);
  const env = getGkvEnv();

  return respond.ok(
    {
      status: "ok",
      scope: "webhooks",
      service: "guide-kit-viewer-backend",
      enabled: env.enabled,
    },
    { correlationId },
  );
};
