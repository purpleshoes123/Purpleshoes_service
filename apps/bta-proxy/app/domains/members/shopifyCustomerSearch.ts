export type CustomerSearchItem = {
  id: string;
  displayName?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

export function formatCustomerSearchLabel(customer: CustomerSearchItem): string {
  return (
    customer.displayName ||
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
    customer.email ||
    customer.id
  );
}
