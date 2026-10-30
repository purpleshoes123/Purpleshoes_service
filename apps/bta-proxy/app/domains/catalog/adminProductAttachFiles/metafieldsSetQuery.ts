export const METAFIELDS_SET_MUTATION = `
  mutation setProductMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        namespace
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type MetafieldsSetResponse = {
  data?: {
    metafieldsSet?: {
      userErrors?: Array<{ field?: string[]; message?: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

export function mapMetafieldsSetErrors(resp: MetafieldsSetResponse): {
  ok: boolean;
  errors: Array<{ field?: string[]; message: string }>;
} {
  const topLevelErrors = resp?.errors ?? [];
  const userErrors = resp?.data?.metafieldsSet?.userErrors ?? [];

  const merged = [
    ...topLevelErrors.map((error) => ({
      message: error.message ?? "Unknown error",
    })),
    ...userErrors.map((error) => ({
      field: error.field,
      message: error.message ?? "Unknown user error",
    })),
  ];

  return {
    ok: merged.length === 0,
    errors: merged,
  };
}
