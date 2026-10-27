import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

const SET_PRODUCT_DRAFT_MUTATION = `
  mutation setProductDraft($id: ID!) {
    productUpdate(product: { id: $id, status: DRAFT }) {
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

type SetDraftResponse = {
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

function formatUserErrors(
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

export async function setProductDraft(
  adminClient: AdminApiContext,
  productId: string
): Promise<{ productId: string; status: string }> {
  const response = await adminClient.graphql(SET_PRODUCT_DRAFT_MUTATION, {
    variables: { id: productId },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin GraphQL product status DRAFT 전환 실패: productId=${productId}`
    );
  }

  const json = (await response.json()) as SetDraftResponse;
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error) => error?.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Shopify Admin GraphQL product status DRAFT 전환 실패: ${errorMessage}; productId=${productId}`
    );
  }

  const userErrors = formatUserErrors(json?.data?.productUpdate?.userErrors ?? []);
  if (userErrors.length > 0) {
    throw new Error(
      `product status DRAFT 전환 실패: ${userErrors.join(", ")}; productId=${productId}`
    );
  }

  const product = json?.data?.productUpdate?.product;
  if (!product?.id || !product.status) {
    throw new Error("productUpdate 응답에서 product 정보를 찾을 수 없습니다.");
  }

  return { productId: product.id, status: product.status };
}
