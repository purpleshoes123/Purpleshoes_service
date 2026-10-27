import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

// This must remain a resource route. An ErrorBoundary makes React Router render
// Shopify's HTML token-refresh response as an error page showing only "200".
export const headers: HeadersFunction = (args) => boundary.headers(args);
