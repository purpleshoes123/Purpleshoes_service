export const PRODUCT_CREATE_MEDIA_MUTATION = `
  mutation addProductHeroMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        ... on MediaImage {
          id
        }
      }
      mediaUserErrors {
        field
        message
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type ProductCreateMediaResponse = {
  data?: {
    productCreateMedia?: {
      media?: Array<{ id?: string }>;
      mediaUserErrors?: Array<{ field?: string[]; message?: string }>;
      userErrors?: Array<{ field?: string[]; message?: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

export function mapHeroMediaResult(resp: ProductCreateMediaResponse): {
  ok: boolean;
  mediaIds?: string[];
  errors?: string[];
} {
  const topLevelErrors = resp?.errors ?? [];
  const userErrors = resp?.data?.productCreateMedia?.userErrors ?? [];
  const mediaUserErrors = resp?.data?.productCreateMedia?.mediaUserErrors ?? [];

  const errors = [
    ...topLevelErrors.map((error) => error.message ?? "Unknown error"),
    ...userErrors.map((error) => error.message ?? "Unknown user error"),
    ...mediaUserErrors.map((error) => error.message ?? "Unknown media user error"),
  ].filter(Boolean);

  const mediaIds =
    resp?.data?.productCreateMedia?.media?.map((media) => media.id).filter(Boolean) ?? [];

  // TODO: fileId만으로는 productCreateMedia에 연결할 수 없음.
  // originalSource URL이 필요하므로 Phase5-6에서 대체안(메타필드 저장/URL 확보)을 확정해야 함.
  return {
    ok: errors.length === 0,
    mediaIds: mediaIds.length > 0 ? (mediaIds as string[]) : undefined,
    errors: errors.length > 0 ? errors : undefined,
  };
}
