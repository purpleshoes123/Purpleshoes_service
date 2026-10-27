export const METAFIELDS_SET_MUTATION = `
  mutation setExternalKeyMetafield($metafields: [MetafieldsSetInput!]!) {
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

/**
 * external_key 단일 세팅 전용 매퍼.
 * - ownerId=productId
 * - namespace='travel', key='external_key'
 * - type='single_line_text_field'
 */
export function mapMetafieldsSet(resp: MetafieldsSetResponse): {
  userErrors: Array<{ field?: string[]; message?: string }>;
  errors: Array<{ message?: string }>;
} {
  return {
    userErrors: resp?.data?.metafieldsSet?.userErrors ?? [],
    errors: resp?.errors ?? [],
  };
}
