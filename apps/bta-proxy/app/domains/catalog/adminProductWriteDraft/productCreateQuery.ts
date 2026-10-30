import type {
  DraftCreateInput,
  DraftCreateResult,
} from "~/domains/catalog/adminProductWriteDraft/types";

export const PRODUCT_CREATE_MUTATION = `
  mutation createDraftProduct($input: ProductCreateInput!) {
    productCreate(product: $input) {
      product {
        id
        handle
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export function buildProductCreateInput(
  input: DraftCreateInput,
  taxonomyNodeId: string,
  handleCandidate?: string,
) {
  return {
    title: input.title,
    descriptionHtml: input.descriptionHtml,
    status: "DRAFT",
    handle: handleCandidate,
    productCategory: {
      productTaxonomyNodeId: taxonomyNodeId,
    },
    metafields: [
      {
        namespace: "travel",
        key: "external_key",
        type: "single_line_text_field",
        value: input.externalKey,
      },
    ],
  };
}

export function mapProductCreate(resp: any): DraftCreateResult {
  const product = resp?.data?.productCreate?.product ?? null;

  return {
    productId: typeof product?.id === "string" ? product.id : "",
    handle: typeof product?.handle === "string" ? product.handle : undefined,
    status: typeof product?.status === "string" ? product.status : undefined,
  };
}
