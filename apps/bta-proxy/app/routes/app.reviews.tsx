import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Outlet } from "react-router";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ ok: true });
};

export default function ReviewsLayout() {
  return <Outlet />;
}
