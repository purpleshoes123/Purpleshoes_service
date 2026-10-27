export const PUBLISH_PRODUCT_MUTATION = `
  mutation publishProduct($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type PublishResponse = {
  data?: {
    publishablePublish?: {
      publishable?: {
        id?: string | null;
      } | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null } | null> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

export function mapPublish(resp: PublishResponse): {
  publishableId: string;
} {
  const publishable = resp?.data?.publishablePublish?.publishable;
  if (!publishable?.id) {
    throw new Error("publishablePublish 응답에서 publishable 정보를 찾을 수 없습니다.");
  }

  return {
    publishableId: publishable.id,
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
