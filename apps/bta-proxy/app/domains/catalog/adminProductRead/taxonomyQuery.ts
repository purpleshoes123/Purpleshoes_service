export type TaxonomyNodeDTO = {
  id: string;
  name: string;
  fullName?: string;
  publicId?: string;
};

export const TAXONOMY_BY_PUBLIC_ID_QUERY = `
  query getTaxonomyCategoryByPublicId($search: String!, $first: Int!) {
    taxonomy {
      categories(first: $first, search: $search) {
        edges {
          node {
            id
            name
            fullName
          }
        }
      }
    }
  }
`;

export function mapTaxonomyNode(
  resp: any,
  publicId: string,
  search?: string,
): TaxonomyNodeDTO | null {
  const edges =
    resp?.data?.taxonomy?.categories?.edges ??
    resp?.data?.productTaxonomyNodes?.edges ??
    resp?.data?.taxonomyNodes?.edges ??
    [];

  if (!Array.isArray(edges) || edges.length === 0) {
    return null;
  }

  let fallbackNode: any = null;
  let matchedNode: any = null;
  let hasPublicId = false;
  const trimmedSearch = search ? search.trim().toLowerCase() : "";
  for (const edge of edges) {
    const node = edge?.node ?? {};
    if (!fallbackNode) {
      fallbackNode = node;
    }
    const nodePublicId = typeof node.publicId === "string" ? node.publicId : undefined;
    if (nodePublicId) {
      hasPublicId = true;
      if (nodePublicId === publicId) {
        matchedNode = node;
        break;
      }
    }
    if (!hasPublicId && trimmedSearch) {
      const nodeName = typeof node.name === "string" ? node.name.trim().toLowerCase() : "";
      const nodeFullName =
        typeof node.fullName === "string" ? node.fullName.trim().toLowerCase() : "";
      if (nodeName === trimmedSearch || nodeFullName === trimmedSearch) {
        matchedNode = node;
        break;
      }
    }
  }

  if (matchedNode) {
    const nodePublicId =
      typeof matchedNode.publicId === "string" ? matchedNode.publicId : undefined;
    return {
      id: typeof matchedNode.id === "string" ? matchedNode.id : "",
      name: typeof matchedNode.name === "string" ? matchedNode.name : "",
      fullName: typeof matchedNode.fullName === "string" ? matchedNode.fullName : undefined,
      publicId: nodePublicId ?? publicId,
    };
  }

  if (!hasPublicId && edges.length === 1 && fallbackNode) {
    return {
      id: typeof fallbackNode.id === "string" ? fallbackNode.id : "",
      name: typeof fallbackNode.name === "string" ? fallbackNode.name : "",
      fullName: typeof fallbackNode.fullName === "string" ? fallbackNode.fullName : undefined,
      publicId: publicId || undefined,
    };
  }

  return null;
}
