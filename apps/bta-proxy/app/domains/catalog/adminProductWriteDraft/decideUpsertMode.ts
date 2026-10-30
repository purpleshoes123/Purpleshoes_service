import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { fetchProductByExternalKey } from "~/domains/catalog/adminProductRead/fetchProductByExternalKey";

export async function decideUpsertMode(
  adminClient: AdminApiContext,
  externalKey: string,
): Promise<"CREATE" | "UPDATE"> {
  const existing = await fetchProductByExternalKey(adminClient, externalKey);
  return existing ? "UPDATE" : "CREATE";
}
