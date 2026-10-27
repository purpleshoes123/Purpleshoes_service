import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import {
  buildStagedUploadCreateMutation,
  mapStagedTarget,
  type StagedTargetDTO,
} from "~/lib/adminFileUpload/stagedUploadQuery";
import {
  UploadError,
  UploadErrorCode,
  type UploadInput,
} from "~/lib/adminFileUpload/types";
import { validateUploadInput } from "~/lib/adminFileUpload/validate";

type StagedUploadPayload = {
  data?: {
    stagedUploadsCreate?: {
      stagedUploadTargets?: Array<{
        url?: string;
        resourceUrl?: string;
        parameters?: Array<{ name?: string; value?: string }>;
      }>;
      stagedTargets?: Array<{
        url?: string;
        resourceUrl?: string;
        parameters?: Array<{ name?: string; value?: string }>;
      }>;
      userErrors?: Array<{ message?: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

const STAGED_TARGET_FIELD_CANDIDATES = [
  "stagedUploadTargets",
  "stagedTargets",
];
let stagedTargetFieldName: string | null | undefined;

function shouldRetryField(
  errors: Array<{ message?: string }>,
  fieldName: string
): boolean {
  return errors.some((error) => {
    const message = error.message || "";
    return (
      message.includes(`Field '${fieldName}'`) &&
      message.includes("doesn't exist")
    );
  });
}

async function resolveStagedTargetField(
  adminClient: AdminApiContext
): Promise<string[]> {
  if (stagedTargetFieldName !== undefined) {
    return stagedTargetFieldName
      ? [stagedTargetFieldName]
      : STAGED_TARGET_FIELD_CANDIDATES;
  }

  const query = `
    query IntrospectStagedUploadsCreatePayload {
      type: __type(name: "StagedUploadsCreatePayload") {
        fields {
          name
        }
      }
    }
  `;

  try {
    const response = await adminClient.graphql(query);
    if (!response.ok) {
      stagedTargetFieldName = null;
      return STAGED_TARGET_FIELD_CANDIDATES;
    }
    const json = await response.json();
    const fieldNames = (json?.data?.type?.fields ?? [])
      .map((field: { name?: string | null }) => field?.name)
      .filter((name): name is string => typeof name === "string");
    const resolved =
      fieldNames.find((name) => name === "stagedUploadTargets") ||
      fieldNames.find((name) => name === "stagedTargets") ||
      fieldNames.find((name) => /staged.*target/i.test(name));
    stagedTargetFieldName = resolved ?? null;
    return stagedTargetFieldName
      ? [stagedTargetFieldName]
      : STAGED_TARGET_FIELD_CANDIDATES;
  } catch {
    stagedTargetFieldName = null;
    return STAGED_TARGET_FIELD_CANDIDATES;
  }
}

export async function createStagedUploadTarget(
  adminClient: AdminApiContext,
  file: UploadInput
): Promise<StagedTargetDTO> {
  validateUploadInput(file);

  const fieldCandidates = await resolveStagedTargetField(adminClient);
  let lastError: UploadError | null = null;

  for (const fieldName of fieldCandidates) {
    const response = await adminClient.graphql(
      buildStagedUploadCreateMutation(fieldName),
      {
        variables: {
          input: [
            {
          resource: "IMAGE",
          filename: file.filename,
          mimeType: file.mimeType,
          fileSize: String(file.sizeBytes),
        },
          ],
        },
      }
    );

    if (!response.ok) {
      lastError = new UploadError(
        UploadErrorCode.STAGED_UPLOAD_FAILED,
        `stagedUploadsCreate 요청 실패 (status=${response.status})`,
        {
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }
      );
      lastError.reason = `status=${response.status}`;
      continue;
    }

    const payload = (await response.json()) as StagedUploadPayload;
    const graphqlErrors = payload.errors || [];
    if (graphqlErrors.length > 0) {
      if (shouldRetryField(graphqlErrors, fieldName)) {
        lastError = new UploadError(
          UploadErrorCode.STAGED_UPLOAD_FAILED,
          `stagedUploadsCreate 실패: ${graphqlErrors
            .map((error) => error.message)
            .filter(Boolean)
            .join(", ")}`,
          {
            filename: file.filename,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          }
        );
        lastError.reason = graphqlErrors
          .map((error) => error.message)
          .filter(Boolean)
          .join(", ");
        continue;
      }
      const message = graphqlErrors
        .map((error) => error.message)
        .filter(Boolean)
        .join(", ");
      const isPermissionError =
        message.toLowerCase().includes("permission") ||
        message.toLowerCase().includes("access") ||
        message.toLowerCase().includes("write_files");
      const errorMessage = isPermissionError
        ? `stagedUploadsCreate 실패: write_files 권한이 필요합니다. ${message}`
        : message
        ? `stagedUploadsCreate 실패: ${message}`
        : "stagedUploadsCreate 실패";
      const uploadError = new UploadError(
        UploadErrorCode.STAGED_UPLOAD_FAILED,
        errorMessage,
        {
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }
      );
      uploadError.reason = message || errorMessage;
      throw uploadError;
    }

    const userErrors = payload.data?.stagedUploadsCreate?.userErrors || [];
    if (userErrors.length > 0) {
      const message = userErrors
        .map((error) => error.message)
        .filter(Boolean)
        .join(", ");
      const isPermissionError =
        message.toLowerCase().includes("permission") ||
        message.toLowerCase().includes("access") ||
        message.toLowerCase().includes("write_files");
      const errorMessage = isPermissionError
        ? `stagedUploadsCreate 실패: write_files 권한이 필요합니다. ${message}`
        : message
        ? `stagedUploadsCreate 실패: ${message}`
        : "stagedUploadsCreate 실패";
      const uploadError = new UploadError(
        UploadErrorCode.STAGED_UPLOAD_FAILED,
        errorMessage,
        {
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }
      );
      uploadError.reason = message || errorMessage;
      throw uploadError;
    }

    const target = mapStagedTarget(payload, fieldName);
    if (!target) {
      lastError = new UploadError(
        UploadErrorCode.STAGED_UPLOAD_FAILED,
        "stagedUploadsCreate 실패: staged upload target이 비어 있습니다.",
        {
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }
      );
      lastError.reason = "staged upload target empty";
      continue;
    }

    return target;
  }

  if (lastError) {
    throw lastError;
  }

  const error = new UploadError(
    UploadErrorCode.STAGED_UPLOAD_FAILED,
    "stagedUploadsCreate 실패: staged upload target을 찾지 못했습니다.",
    {
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
    }
  );
  error.reason = "staged upload target not found";
  throw error;
}
