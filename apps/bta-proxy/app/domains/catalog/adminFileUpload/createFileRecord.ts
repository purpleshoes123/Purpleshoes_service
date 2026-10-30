import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  UploadError,
  UploadErrorCode,
  type UploadInput,
  type UploadResult,
} from "~/domains/catalog/adminFileUpload/types";

type FileCreatePayload = {
  data?: {
    fileCreate?: {
      file?: {
        id?: string;
        status?: string;
        preview?: {
          image?: { url?: string };
        };
      } | null;
      userErrors?: Array<{ message?: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

const FILE_CREATE_MUTATION = `
  mutation createFileRecord($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        preview {
          image {
            url
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function resolveContentType(mimeType?: UploadInput["mimeType"]): "IMAGE" {
  if (mimeType === "image/jpeg" || mimeType === "image/png") {
    return "IMAGE";
  }
  return "IMAGE";
}

export async function createFileRecord(
  adminClient: AdminApiContext,
  resourceUrl: string,
  alt?: string,
  mimeType?: UploadInput["mimeType"],
): Promise<UploadResult> {
  const response = await adminClient.graphql(FILE_CREATE_MUTATION, {
    variables: {
      files: [
        {
          originalSource: resourceUrl,
          contentType: resolveContentType(mimeType),
          alt,
        },
      ],
    },
  });

  if (!response.ok) {
    throw new UploadError(
      UploadErrorCode.FILE_CREATE_FAILED,
      `fileCreate 요청 실패 (status=${response.status})`,
    );
  }

  const payload = (await response.json()) as FileCreatePayload;
  const graphqlErrors = payload.errors || [];
  if (graphqlErrors.length > 0) {
    const message = graphqlErrors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new UploadError(
      UploadErrorCode.FILE_CREATE_FAILED,
      message ? `fileCreate 실패: ${message}` : "fileCreate 실패",
    );
  }

  const userErrors = payload.data?.fileCreate?.userErrors || [];
  if (userErrors.length > 0) {
    const message = userErrors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new UploadError(
      UploadErrorCode.FILE_CREATE_FAILED,
      message ? `fileCreate 실패: ${message}` : "fileCreate 실패",
    );
  }

  const file = payload.data?.fileCreate?.files?.[0] ?? null;
  const fileId = file?.id ?? "";
  if (!fileId) {
    throw new UploadError(
      UploadErrorCode.FILE_CREATE_FAILED,
      "fileCreate 실패: fileId가 비어 있습니다.",
    );
  }

  return {
    fileId,
    alt,
    previewUrl: file?.preview?.image?.url,
  };
}
