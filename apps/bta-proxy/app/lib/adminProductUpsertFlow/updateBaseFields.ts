import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  TRAVEL_TAXONOMY_PUBLIC_ID,
  fetchTaxonomyNodeByPublicId,
} from "~/lib/adminProductRead/fetchTaxonomy";
import {
  buildCategoryInput,
  resolveUpdateCategoryField,
} from "~/lib/adminProductCategory/resolveCategoryInput";

const DEFAULT_TAXONOMY_PUBLIC_ID = "se-4-4";

const PRODUCT_UPDATE_MUTATION = `
  mutation updateProductBase($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
        title
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type ProductUpdateResponse = {
  data?: {
    productUpdate?: {
      product?: { id?: string | null } | null;
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

export async function updateBaseFields(
  adminClient: AdminApiContext,
  productId: string,
  input: {
    title: string;
    descriptionHtml: string;
    taxonomyPublicId?: string;
  }
): Promise<{ productId: string }> {
  const taxonomyPublicId =
    input.taxonomyPublicId ||
    TRAVEL_TAXONOMY_PUBLIC_ID ||
    DEFAULT_TAXONOMY_PUBLIC_ID;
  const taxonomyNode = await fetchTaxonomyNodeByPublicId(
    adminClient,
    taxonomyPublicId
  );
  if (!taxonomyNode.id) {
    throw new Error(
      `카테고리 조회 실패: productTaxonomyNodeId 누락 (publicId=${taxonomyPublicId})`
    );
  }

  const productInput: Record<string, unknown> = {
    id: productId,
    title: input.title,
    descriptionHtml: input.descriptionHtml,
  };
  const categoryField = await resolveUpdateCategoryField(adminClient);
  if (!categoryField) {
    throw new Error(
      `카테고리 입력 필드가 ProductUpdateInput에 없습니다. (publicId=${taxonomyPublicId})`
    );
  }
  Object.assign(
    productInput,
    buildCategoryInput(categoryField, taxonomyNode.id)
  );

  const response = await adminClient.graphql(PRODUCT_UPDATE_MUTATION, {
    variables: {
      product: productInput,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Shopify Admin GraphQL productUpdate 실패: productId=${productId}`
    );
  }

  const json = (await response.json()) as ProductUpdateResponse;
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error) => error?.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Shopify Admin GraphQL productUpdate 실패: ${errorMessage}; productId=${productId}`
    );
  }

  const userErrors = formatUserErrors(json.data?.productUpdate?.userErrors ?? []);
  if (userErrors.length > 0) {
    throw new Error(
      `productUpdate 실패: ${userErrors.join(", ")}; productId=${productId}`
    );
  }

  const updatedId = json.data?.productUpdate?.product?.id ?? null;
  if (!updatedId) {
    throw new Error("productUpdate 응답에서 productId를 찾을 수 없습니다.");
  }

  return { productId: updatedId };
}
