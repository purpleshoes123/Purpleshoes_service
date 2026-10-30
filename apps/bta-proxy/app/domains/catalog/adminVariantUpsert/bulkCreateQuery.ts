export const VARIANTS_BULK_CREATE_MUTATION = `
  mutation variantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
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

type BulkCreateResponse = {
  data?: {
    productVariantsBulkCreate?: {
      productVariants?: Array<{ id?: string | null } | null> | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null } | null> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

export function mapBulkCreate(resp: BulkCreateResponse): {
  createdIds: string[];
  errors?: string[];
} {
  const createdIds = (resp.data?.productVariantsBulkCreate?.productVariants ?? [])
    .map((variant) => variant?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const errors: string[] = [];

  for (const error of resp.errors ?? []) {
    if (error?.message) {
      errors.push(error.message);
    }
  }

  for (const userError of resp.data?.productVariantsBulkCreate?.userErrors ?? []) {
    if (!userError) {
      continue;
    }
    const field = userError.field?.filter(Boolean).join(".") ?? "";
    const message = userError.message ?? "";
    if (field && message) {
      errors.push(`${field}: ${message}`);
    } else if (message) {
      errors.push(message);
    }
  }

  return {
    createdIds,
    ...(errors.length > 0 ? { errors } : {}),
  };
}
