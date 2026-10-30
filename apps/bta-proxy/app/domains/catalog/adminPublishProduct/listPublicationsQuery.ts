export type PublicationDTO = {
  id: string;
  name: string;
  isOnlineStore: boolean;
};

export const LIST_PUBLICATIONS_QUERY = `
  query listPublications($first: Int!, $after: String) {
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
    const isOnlineStore = name.trim().toLowerCase().includes("online store");

    return {
      id: typeof node.id === "string" ? node.id : "",
      name,
      isOnlineStore,
    };
  });
}
