import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisProvider } from "@shopify/polaris";
import polarisEnglish from "@shopify/polaris/locales/en.json";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { AdminLink } from "../lib/adminLink";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisProvider i18n={polarisEnglish} linkComponent={AdminLink}>
        <NavMenu>
          <Link to="/app/bookings" rel="home">
            Home
          </Link>
          <Link to="/app/bookings">Bookings</Link>
          <Link to="/app/blackouts">Global blackout</Link>
          <Link to="/app/products/upsert">Products</Link>
          <Link to="/app/reviews">Reviews</Link>
          <Link to="/app/coupons">Coupons</Link>
          <Link to="/app/mail">Mail</Link>
          <Link to="/app/gkv/guides">GKV Guides</Link>
          <Link to="/app/gkv/categories">GKV Categories</Link>
          <Link to="/app/gkv/restaurants">GKV Restaurants</Link>
          <Link to="/app/gkv/entitlements">GKV Entitlements</Link>
          <Link to="/app/gkv/sessions">GKV Sessions</Link>
          <Link to="/app/gkv/settings">GKV Settings</Link>
        </NavMenu>
        <Outlet />
      </PolarisProvider>
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
