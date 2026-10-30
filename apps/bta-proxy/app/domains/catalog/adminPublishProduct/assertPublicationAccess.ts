import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export const PUBLICATION_ACCESS_QUERY = `
  query publicationAccess { currentAppInstallation { accessScopes { handle } } }
`;

export async function assertPublicationAccess(admin: AdminApiContext): Promise<void> {
  const response = await admin.graphql(PUBLICATION_ACCESS_QUERY);
  if (!response.ok) {
    throw new Error("게시 권한을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error("게시 권한을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }
  const scopes = payload.data?.currentAppInstallation?.accessScopes;
  if (
    !Array.isArray(scopes) ||
    !scopes.some((scope: { handle: string }) => scope.handle === "write_publications")
  ) {
    throw new Error(
      "앱에 판매 채널 게시 권한(write_publications)이 없습니다. 관리자에게 앱 권한 승인을 요청해 주세요. 가격·내용만 수정하려면 Save Changes를 사용하세요.",
    );
  }
}
