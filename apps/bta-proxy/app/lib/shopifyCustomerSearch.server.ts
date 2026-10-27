import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { CustomerSearchItem } from "~/lib/shopifyCustomerSearch";

async function runGraphql(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown>
): Promise<any> {
  const response = await admin.graphql(query, { variables });
  if (!response.ok) {
    throw new Error(`Shopify Admin API request failed: ${response.status}`);
  }
  return await response.json();
}

function toCustomerGid(value: string): string | null {
  if (!value) return null;
  if (value.startsWith("gid://")) return value;
  if (/^\d+$/.test(value)) {
    return `gid://shopify/Customer/${value}`;
  }
  return null;
}

function buildCustomerSearchQuery(value: string): string {
  const sanitized = value.replace(/"/g, "").trim();
  if (!sanitized) return "";
  if (sanitized.includes("@")) {
    return `email:${sanitized}`;
  }
  return `name:*${sanitized}* OR email:*${sanitized}*`;
}

export async function searchCustomers(
  admin: AdminApiContext,
  term: string
): Promise<CustomerSearchItem[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];

  const gid = toCustomerGid(trimmed);
  if (gid) {
    const query = `
      query customerById($id: ID!) {
        customer(id: $id) {
          id
          displayName
          email
          firstName
          lastName
        }
      }
    `;
    const payload = await runGraphql(admin, query, { id: gid });
    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((error: any) => error.message).join(", "));
    }
    const customer = payload.data?.customer;
    return customer ? [customer] : [];
  }

  const searchQuery = buildCustomerSearchQuery(trimmed);
  if (!searchQuery) return [];

  const query = `
    query customersSearch($query: String!, $first: Int!) {
      customers(first: $first, query: $query) {
        nodes {
          id
          displayName
          email
          firstName
          lastName
        }
      }
    }
  `;
  const payload = await runGraphql(admin, query, {
    query: searchQuery,
    first: 10,
  });
  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  }
  return payload.data?.customers?.nodes ?? [];
}
