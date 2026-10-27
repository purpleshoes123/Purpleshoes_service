export const VARIANTS_BULK_UPDATE_MUTATION = `
  mutation variantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type BulkUpdateResponse = {
  data?: {
    productVariantsBulkUpdate?: {
      productVariants?: Array<{ id?: string | null } | null> | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null } | null> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

export function mapBulkUpdate(resp: BulkUpdateResponse): {
  ok: boolean;
  errors?: string[];
} {
  const errors: string[] = [];

  for (const error of resp.errors ?? []) {
    if (error?.message) {
      errors.push(error.message);
    }
  }

  for (const userError of resp.data?.productVariantsBulkUpdate?.userErrors ?? []) {
    if (!userError) continue;
    const field = userError.field?.filter(Boolean).join(".") ?? "";
    const message = userError.message ?? "";
    if (field && message) {
      errors.push(`${field}: ${message}`);
    } else if (message) {
      errors.push(message);
    }
  }

  return {
    ok: errors.length === 0,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
