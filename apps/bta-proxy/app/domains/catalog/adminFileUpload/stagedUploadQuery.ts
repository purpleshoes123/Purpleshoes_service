export type StagedTargetDTO = {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

export function buildStagedUploadCreateMutation(targetFieldName: string): string {
  return `
    mutation createStagedUploadTarget($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        ${targetFieldName} {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
}

export function mapStagedTarget(resp: any, targetFieldName: string): StagedTargetDTO | null {
  const target = resp?.data?.stagedUploadsCreate?.[targetFieldName]?.[0] ?? null;

  if (!target) {
    return null;
  }

  const parameters = Array.isArray(target.parameters) ? target.parameters : [];

  return {
    url: typeof target.url === "string" ? target.url : "",
    resourceUrl: typeof target.resourceUrl === "string" ? target.resourceUrl : "",
    parameters: parameters
      .filter((item: any) => item?.name && item?.value != null)
      .map((item: any) => ({
        name: typeof item?.name === "string" ? item.name : "",
        value: String(item.value),
      }))
      .filter((item) => item.name),
  };
}
