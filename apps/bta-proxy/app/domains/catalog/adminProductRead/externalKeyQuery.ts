export type ProductSummaryDTO = {
  id: string;
  title: string;
  handle?: string;
  status?: string;
  externalKey?: string;
};

export const PRODUCTS_BY_QUERY_QUERY = `
  query getProductsByQuery($query: String!, $first: Int!, $after: String) {
    products(query: $query, first: $first, after: $after) {
      edges {
        node {
          id
          title
          handle
          status
          metafields(namespace: "travel", first: 20) {
            edges {
              node {
                namespace
                key
                value
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export function mapProductsByExternalKey(resp: any, externalKey: string): ProductSummaryDTO[] {
  const edges = resp?.data?.products?.edges ?? [];
  const results: ProductSummaryDTO[] = [];

  for (const edge of edges) {
    const node = edge?.node ?? {};
    const metafields = node?.metafields?.edges ?? [];
    const externalKeyField = metafields
      .map((item: any) => item?.node)
      .find((meta: any) => meta?.namespace === "travel" && meta?.key === "external_key");

    if (externalKeyField?.value !== externalKey) {
      continue;
    }

    results.push({
      id: typeof node.id === "string" ? node.id : "",
      title: typeof node.title === "string" ? node.title : "",
      handle: typeof node.handle === "string" ? node.handle : undefined,
      status: typeof node.status === "string" ? node.status : undefined,
      externalKey,
    });
  }

  return results;
}
