export const SET_PRODUCT_ACTIVE_MUTATION = `
  mutation setProductActive($id: ID!) {
    productUpdate(product: { id: $id, status: ACTIVE }) {
      product {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type SetActiveResponse = {
  data?: {
    productUpdate?: {
      product?: {
        id?: string | null;
        status?: string | null;
      } | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null } | null> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

export function mapSetActive(resp: SetActiveResponse): {
  productId: string;
  status: string;
} {
  const product = resp?.data?.productUpdate?.product;
  if (!product?.id || !product?.status) {
    throw new Error("productUpdate 응답에서 product 정보를 찾을 수 없습니다.");
  }

  return {
    productId: product.id,
    status: product.status,
  };
}

export function formatUserErrors(
  errors: Array<{ field?: string[] | null; message?: string | null } | null>
): string[] {
  return errors
    .filter(Boolean)
    .map((error) => {
      const field = error?.field?.filter(Boolean).join(".") ?? "";
      const message = error?.message ?? "";
      if (field && message) return `${field}: ${message}`;
      return message;
    })
    .filter((value) => value.length > 0);
}
