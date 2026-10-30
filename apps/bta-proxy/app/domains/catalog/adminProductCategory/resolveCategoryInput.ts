import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

type CategoryFieldConfig = {
  fieldName: string;
  inputFieldName?: string;
};

type InputField = {
  name: string;
  type: any;
};

type InputTypeInfo = {
  name: string;
  kind: string;
  inputFields: InputField[];
};

const INPUT_TYPE_QUERY = `
  query IntrospectInputType($typeName: String!) {
    type: __type(name: $typeName) {
      name
      kind
      inputFields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
`;

let createFieldCache: CategoryFieldConfig | null | undefined;
let updateFieldCache: CategoryFieldConfig | null | undefined;

function unwrapTypeName(type: any): string {
  if (!type) {
    return "";
  }
  if (type.name) {
    return type.name;
  }
  if (type.ofType) {
    return unwrapTypeName(type.ofType);
  }
  return "";
}

function formatTypeRef(type: any): string {
  if (!type) {
    return "";
  }
  if (type.kind === "NON_NULL") {
    return `${formatTypeRef(type.ofType)}!`;
  }
  if (type.kind === "LIST") {
    return `[${formatTypeRef(type.ofType)}]`;
  }
  return type.name || "";
}

function findCategoryField(fields: InputField[]): InputField | null {
  const candidates = fields.filter((field) => /category|taxonomy/i.test(field?.name || ""));
  if (candidates.length === 0) {
    return null;
  }
  const preferred = [
    "productCategory",
    "category",
    "productTaxonomyNodeId",
    "taxonomyNodeId",
    "productCategoryId",
  ];
  for (const name of preferred) {
    const match = candidates.find((candidate) => candidate.name === name);
    if (match) {
      return match;
    }
  }
  return candidates[0];
}

async function introspectInputType(
  adminClient: AdminApiContext,
  typeName: string,
): Promise<InputTypeInfo | null> {
  const response = await adminClient.graphql(INPUT_TYPE_QUERY, {
    variables: { typeName },
  });
  if (!response.ok) {
    return null;
  }
  const json = await response.json();
  if (json?.errors?.length) {
    return null;
  }
  const type = json?.data?.type ?? null;
  if (!type?.name) {
    return null;
  }
  const inputFields = Array.isArray(type.inputFields) ? type.inputFields : [];
  return {
    name: type.name,
    kind: type.kind ?? "",
    inputFields,
  };
}

async function resolveCategoryFieldConfig(
  adminClient: AdminApiContext,
  inputTypeName: string,
): Promise<CategoryFieldConfig | null> {
  const typeInfo = await introspectInputType(adminClient, inputTypeName);
  if (!typeInfo) {
    return null;
  }

  const candidateField = findCategoryField(typeInfo.inputFields);
  if (!candidateField) {
    console.log(
      JSON.stringify({
        message: "category input field not found",
        inputTypeName,
        inputFields: typeInfo.inputFields.map((field) => field.name),
      }),
    );
    return null;
  }

  const fieldTypeName = unwrapTypeName(candidateField.type);
  if (!fieldTypeName) {
    return null;
  }

  if (fieldTypeName === "ID" || fieldTypeName === "String") {
    console.log(
      JSON.stringify({
        message: "category input field resolved",
        inputTypeName,
        fieldName: candidateField.name,
        fieldType: formatTypeRef(candidateField.type),
      }),
    );
    return { fieldName: candidateField.name };
  }

  const nestedType = await introspectInputType(adminClient, fieldTypeName);
  const nestedFields = nestedType?.inputFields ?? [];
  const nestedCandidate =
    nestedFields.find((field) => /taxonomy/i.test(field.name) && /id/i.test(field.name)) ??
    nestedFields.find((field) => field.name === "id");

  if (!nestedCandidate) {
    console.log(
      JSON.stringify({
        message: "category nested input field not found",
        inputTypeName,
        fieldName: candidateField.name,
        fieldType: fieldTypeName,
        nestedFields: nestedFields.map((field) => field.name),
      }),
    );
    return null;
  }

  console.log(
    JSON.stringify({
      message: "category input field resolved",
      inputTypeName,
      fieldName: candidateField.name,
      fieldType: formatTypeRef(candidateField.type),
      nestedFieldName: nestedCandidate.name,
      nestedFieldType: formatTypeRef(nestedCandidate.type),
    }),
  );

  return {
    fieldName: candidateField.name,
    inputFieldName: nestedCandidate.name,
  };
}

export async function resolveCreateCategoryField(
  adminClient: AdminApiContext,
): Promise<CategoryFieldConfig | null> {
  if (createFieldCache !== undefined) {
    return createFieldCache;
  }
  createFieldCache = await resolveCategoryFieldConfig(adminClient, "ProductCreateInput");
  return createFieldCache;
}

export async function resolveUpdateCategoryField(
  adminClient: AdminApiContext,
): Promise<CategoryFieldConfig | null> {
  if (updateFieldCache !== undefined) {
    return updateFieldCache;
  }
  updateFieldCache = await resolveCategoryFieldConfig(adminClient, "ProductUpdateInput");
  return updateFieldCache;
}

export function buildCategoryInput(
  config: CategoryFieldConfig,
  taxonomyNodeId: string,
): Record<string, unknown> {
  if (config.inputFieldName) {
    return {
      [config.fieldName]: {
        [config.inputFieldName]: taxonomyNodeId,
      },
    };
  }
  return {
    [config.fieldName]: taxonomyNodeId,
  };
}
