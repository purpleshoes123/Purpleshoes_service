import { getAdminApiClient } from '~/lib/shopifyAdmin';
import { REVIEW_SHOP, REVIEW_TAG, unavailable } from './auth.server';

export const REVIEW_CUSTOMER_QUERY = `query ReviewCustomer($id: ID!) {
  customer(id: $id) { id firstName lastName tags }
}`;
export const REVIEW_ORDERS_QUERY = `query ReviewOrders($id: ID!) {
  customer(id: $id) { id tags orders(first: 50, reverse: true, sortKey: PROCESSED_AT) {
    nodes { id cancelledAt financialStatus: displayFinancialStatus
      lineItems(first: 50) { nodes { id name customAttributes { key value } } }
    }
  } }
}`;
type ReviewCustomer = { id: string; firstName?: string; lastName?: string; tags: string[];
  orders?: { nodes: unknown[] } };
async function readDedicatedCustomer(customerId: string, query: string): Promise<ReviewCustomer> {
  const admin = await getAdminApiClient(REVIEW_SHOP);
  if (!admin) return unavailable();
  const response = await admin.graphql(query, { variables: { id: customerId } });
  const payload = await response.json();
  const customer = payload?.data?.customer as ReviewCustomer | undefined;
  if (!response.ok || payload.errors?.length || !customer || customer.id !== customerId ||
    !Array.isArray(customer.tags) || !customer.tags.includes(REVIEW_TAG)) return unavailable();
  return customer;
}
export async function checkDedicatedAccount(customerId: string) { await readDedicatedCustomer(customerId, REVIEW_CUSTOMER_QUERY); }
export async function reviewProfile(customerId: string) {
  const customer = await readDedicatedCustomer(customerId, REVIEW_CUSTOMER_QUERY);
  return { customerGid: customer.id, displayName: [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'App Review' };
}
export async function reviewOrders(customerId: string) {
  const customer = await readDedicatedCustomer(customerId, REVIEW_ORDERS_QUERY);
  return { orders: customer.orders?.nodes || [] };
}
