export type ProductVariantsSnapshot = {
  productId: string;
  options: Array<{ name: string; values: string[] }>;
  variants: Array<{
    id: string;
    selectedOptions: Array<{ name: string; value: string }>;
    price: number;
  }>;
};

export const PRODUCT_VARIANTS_SNAPSHOT_QUERY = `
  query getProductVariantsSnapshot($productId: ID!) {
    product(id: $productId) {
      id
      options {
        name
        values
      }
      variants(first: 100) {
        edges {
          node {
            id
            price
            selectedOptions {
              name
              value
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

type GraphQLResponse = {
  data?: {
    product?: {
      id?: string | null;
      options?: Array<{ name?: string | null; values?: string[] | null }> | null;
      variants?: {
        edges?: Array<{
          node?: {
            id?: string | null;
            price?: string | number | null;
            selectedOptions?: Array<{
              name?: string | null;
              value?: string | null;
            }> | null;
          } | null;
        }> | null;
      } | null;
    } | null;
  } | null;
};

export function mapSnapshot(resp: GraphQLResponse): ProductVariantsSnapshot {
  const product = resp.data?.product;
  if (!product?.id) {
    throw new Error("Product not found in snapshot response.");
  }

  const options = (product.options ?? []).map((option) => {
    const name = option?.name ?? "";
    const values = option?.values ?? [];
    return { name, values };
  });

  const variants = (product.variants?.edges ?? [])
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((node) => {
      const id = node?.id ?? "";
      const priceValue = node?.price ?? 0;
      const price = typeof priceValue === "string" ? Number(priceValue) : priceValue;
      const selectedOptions = (node?.selectedOptions ?? []).map((opt) => ({
        name: opt?.name ?? "",
        value: opt?.value ?? "",
      }));
      return { id, selectedOptions, price };
    });

  return {
    productId: product.id,
    options,
    variants,
  };
}
