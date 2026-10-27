export type PublicationDTO = {
  id: string;
  name: string;
  isOnlineStoreHint: boolean;
};

export const PUBLICATIONS_QUERY = `
  query getPublications($first: Int!, $after: String) {
    publications(first: $first, after: $after) {
      edges {
        node {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export function mapPublications(resp: any): PublicationDTO[] {
  const edges = resp?.data?.publications?.edges ?? [];

  return edges.map((edge: any) => {
    const node = edge?.node ?? {};
    const name = typeof node.name === "string" ? node.name : "";
    const isOnlineStoreHint = name === "Online Store";

    return {
      id: typeof node.id === "string" ? node.id : "",
      name,
      isOnlineStoreHint,
    };
  });
}
