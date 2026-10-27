import type { LoaderFunctionArgs } from "react-router";
import { requireGkvCustomerId } from "~/lib/gkv/customerAuth";
import { listActiveGkvSessions } from "~/lib/gkv/sessions.server";
import { respond } from "~/lib/respond";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await requireGkvCustomerId(request);
  if (auth instanceof Response) return auth;
  const correlationId = respond.getCorrelationId(request);

  const sessions = await listActiveGkvSessions(auth.customerId);
  return respond.ok(
    {
      activeSessions: sessions,
      count: sessions.length,
    },
    { correlationId }
  );
};
