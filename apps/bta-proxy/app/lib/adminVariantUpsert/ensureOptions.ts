import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { GraphqlQueryError } from "@shopify/shopify-api";

import { fetchProductVariantsSnapshot } from "./fetchSnapshot";

const PRODUCT_OPTIONS_UPDATE_MUTATION_INPUT = `
  mutation updateProductOptionsInput($id: ID!, $options: [ProductOptionInput!]!) {
    productUpdate(product: { id: $id, options: $options }) {
      product {
        id
        options {
          name
          values
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_OPTIONS_UPDATE_MUTATION_STRING = `
  mutation updateProductOptionsString($id: ID!, $options: [String!]!) {
    productUpdate(product: { id: $id, options: $options }) {
      product {
        id
        options {
          name
          values
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type ProductOption = { name: string; values: string[] };
type OptionsUpdateMode = "input" | "string";

type OptionsUpdateResponse = {
  data?: {
    productUpdate?: {
      product?: {
        id?: string | null;
        options?: Array<{ name?: string | null; values?: string[] | null }> | null;
      } | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null }> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null }> | null;
};

type OptionsCreateResponse = {
  data?: {
    productOptionsCreate?: {
      product?: {
        id?: string | null;
        options?: Array<{ name?: string | null; values?: string[] | null }> | null;
      } | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null }> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null }> | null;
};

type OptionsCreateConfig = {
  argName: string;
  argTypeRef: string;
  inputTypeName: string;
};

let optionsCreateConfig: OptionsCreateConfig | null | undefined;

function unwrapTypeName(type: any): string {
  if (!type) return "";
  if (type.name) return type.name;
  if (type.ofType) return unwrapTypeName(type.ofType);
  return "";
}

function formatTypeRef(type: any): string {
  if (!type) return "";
  if (type.kind === "NON_NULL") return `${formatTypeRef(type.ofType)}!`;
  if (type.kind === "LIST") return `[${formatTypeRef(type.ofType)}]`;
  return type.name || "";
}

async function resolveOptionsCreateConfig(
  adminClient: AdminApiContext
): Promise<OptionsCreateConfig | null> {
  if (optionsCreateConfig !== undefined) return optionsCreateConfig;

  const query = `
    query IntrospectProductOptionsCreate {
      mutationType: __type(name: "Mutation") {
        fields {
          name
          args {
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
                  ofType {
                    kind
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await adminClient.graphql(query);
    if (!response.ok) {
      optionsCreateConfig = null;
      return optionsCreateConfig;
    }
    const json = await response.json();
    if (json?.errors?.length) {
      optionsCreateConfig = null;
      return optionsCreateConfig;
    }

    const fields = json?.data?.mutationType?.fields ?? [];
    const target = fields.find((field: { name?: string }) =>
      field?.name === "productOptionsCreate"
    );
    if (!target) {
      optionsCreateConfig = null;
      return optionsCreateConfig;
    }

    const args = target.args ?? [];
    const optionArg =
      args.find((arg: { name?: string }) => arg?.name !== "productId") ??
      args[0];
    if (!optionArg?.name || !optionArg?.type) {
      optionsCreateConfig = null;
      return optionsCreateConfig;
    }

    optionsCreateConfig = {
      argName: optionArg.name,
      argTypeRef: formatTypeRef(optionArg.type),
      inputTypeName: unwrapTypeName(optionArg.type),
    };
    return optionsCreateConfig;
  } catch (error) {
    optionsCreateConfig = null;
    return optionsCreateConfig;
  }
}

function buildPaxTierValues(maxPax: number): string[] {
  const values: string[] = [];
  for (let i = 1; i <= maxPax; i += 1) {
    values.push(String(i));
  }
  return values;
}

function normalizeOptions(options: ProductOption[]): ProductOption[] {
  return options.map((option) => ({
    name: option.name.trim(),
    values: [...option.values],
  }));
}

function isExactOptionsMatch(a: ProductOption[], b: ProductOption[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].name !== b[i].name) return false;
    if (a[i].values.length !== b[i].values.length) return false;
    for (let j = 0; j < a[i].values.length; j += 1) {
      if (a[i].values[j] !== b[i].values[j]) return false;
    }
  }
  return true;
}

function isOptionNamesMatch(a: ProductOption[], b: ProductOption[]): boolean {
  if (a.length !== b.length) return false;
  const aNames = a.map((option) => option.name);
  const bNames = b.map((option) => option.name);
  for (let i = 0; i < aNames.length; i += 1) {
    if (aNames[i] !== bNames[i]) return false;
  }
  return true;
}

function formatUserErrors(errors: Array<{ field?: string[] | null; message?: string | null }>) {
  return errors
    .map((error) => {
      const field = error.field?.filter(Boolean).join(".") ?? "";
      const message = error.message ?? "";
      return field ? `${field}: ${message}` : message;
    })
    .filter((value) => value.length > 0)
    .join(", ");
}

function extractGraphqlErrors(error: unknown): string[] {
  if (error instanceof GraphqlQueryError) {
    const graphQLErrors = error.body?.errors?.graphQLErrors ?? null;
    if (Array.isArray(graphQLErrors)) {
      return graphQLErrors
        .map((err: { message?: string | null }) => err?.message)
        .filter(Boolean) as string[];
    }
    const errors = error.body?.errors ?? null;
    if (Array.isArray(errors)) {
      return errors
        .map((err: { message?: string | null }) => err?.message)
        .filter(Boolean) as string[];
    }
  }
  const bodyErrors = (error as any)?.body?.errors ?? null;
  if (Array.isArray(bodyErrors)) {
    return bodyErrors
      .map((err: { message?: string | null }) => err?.message)
      .filter(Boolean) as string[];
  }
  return [];
}

function isMissingProductOptionInput(errorMessage: string): boolean {
  return (
    /ProductOptionInput/i.test(errorMessage) &&
    /defined input type|unknown type/i.test(errorMessage)
  );
}

function isOptionsFieldUnsupported(errorMessage: string): boolean {
  return (
    /ProductUpdateInput/i.test(errorMessage) &&
    /doesn't accept argument 'options'/i.test(errorMessage)
  );
}

function buildOptionsCreatePayload(options: ProductOption[]) {
  return options.map((option, index) => ({
    name: option.name,
    position: index + 1,
    values: option.values.map((value) => ({ name: value })),
  }));
}

async function runOptionsUpdate(
  adminClient: AdminApiContext,
  productId: string,
  options: ProductOption[] | string[],
  mode: OptionsUpdateMode
): Promise<void> {
  const response = await adminClient.graphql(
    mode === "input"
      ? PRODUCT_OPTIONS_UPDATE_MUTATION_INPUT
      : PRODUCT_OPTIONS_UPDATE_MUTATION_STRING,
    {
      variables: { id: productId, options },
    }
  );

  if (!response.ok) {
    throw new Error("Shopify Admin GraphQL product options 업데이트 실패");
  }

  const json = (await response.json()) as OptionsUpdateResponse;
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      errorMessage
        ? `Shopify Admin GraphQL product options 업데이트 실패: ${errorMessage}`
        : "Shopify Admin GraphQL product options 업데이트 실패"
    );
  }

  const userErrors = json.data?.productUpdate?.userErrors ?? [];
  if (userErrors.length > 0) {
    const message = formatUserErrors(userErrors);
    throw new Error(
      message
        ? `Product options 업데이트 실패: ${message}`
        : "Product options 업데이트 실패"
    );
  }
}

async function runOptionsCreate(
  adminClient: AdminApiContext,
  productId: string,
  options: ProductOption[]
): Promise<void> {
  const config = await resolveOptionsCreateConfig(adminClient);
  if (!config) {
    throw new Error("productOptionsCreate 입력 타입을 확인할 수 없습니다.");
  }

  const mutation = `
    mutation createProductOptions($productId: ID!, $${config.argName}: ${config.argTypeRef}) {
      productOptionsCreate(productId: $productId, ${config.argName}: $${config.argName}) {
        product {
          id
          options {
            name
            values
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await adminClient.graphql(mutation, {
    variables: {
      productId,
      [config.argName]: buildOptionsCreatePayload(options),
    },
  });

  if (!response.ok) {
    throw new Error("Shopify Admin GraphQL product options 생성 실패");
  }

  const json = (await response.json()) as OptionsCreateResponse;
  if (json?.errors?.length) {
    const errorMessage = json.errors
      .map((error) => error.message)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      errorMessage
        ? `Shopify Admin GraphQL product options 생성 실패: ${errorMessage}`
        : "Shopify Admin GraphQL product options 생성 실패"
    );
  }

  const userErrors = json.data?.productOptionsCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    const message = formatUserErrors(userErrors);
    throw new Error(
      message
        ? `Product options 생성 실패: ${message}`
        : "Product options 생성 실패"
    );
  }
}

export async function ensureProductOptions(
  adminClient: AdminApiContext,
  productId: string,
  maxPax: number
): Promise<void> {
  if (!Number.isInteger(maxPax) || maxPax < 1) {
    throw new Error(`maxPax가 유효하지 않습니다: ${maxPax}`);
  }

  const snapshot = await fetchProductVariantsSnapshot(adminClient, productId);
  const currentOptions = normalizeOptions(snapshot.options ?? []);

  const desiredOptions: ProductOption[] = [
    { name: "Ticket Type", values: ["Adult", "Child", "Infant"] },
    { name: "Pax Tier", values: buildPaxTierValues(maxPax) },
  ];

  const namesMatch = isOptionNamesMatch(currentOptions, desiredOptions);
  const exactMatch = isExactOptionsMatch(currentOptions, desiredOptions);
  if (exactMatch) {
    return;
  }

  const stringPayload = desiredOptions.map((option) => option.name);
  const inputPayload = desiredOptions;

  if (!namesMatch) {
    try {
      await runOptionsUpdate(adminClient, productId, stringPayload, "string");
      return;
    } catch (error) {
      const message =
        extractGraphqlErrors(error).join(", ") ||
        (error instanceof Error ? error.message : String(error));
      if (isOptionsFieldUnsupported(message)) {
        await runOptionsCreate(adminClient, productId, desiredOptions);
        return;
      }
      try {
        await runOptionsUpdate(adminClient, productId, inputPayload, "input");
        return;
      } catch (inputError) {
        const inputMessage =
          extractGraphqlErrors(inputError).join(", ") ||
          (inputError instanceof Error
            ? inputError.message
            : String(inputError));
        if (isOptionsFieldUnsupported(inputMessage)) {
          await runOptionsCreate(
            adminClient,
            productId,
            desiredOptions
          );
          return;
        }
        if (isMissingProductOptionInput(inputMessage)) {
          await runOptionsCreate(
            adminClient,
            productId,
            desiredOptions
          );
          return;
        }
        throw new Error(inputMessage);
      }
    }
  }

  try {
    await runOptionsUpdate(adminClient, productId, inputPayload, "input");
  } catch (error) {
    const message =
      extractGraphqlErrors(error).join(", ") ||
      (error instanceof Error ? error.message : String(error));
    if (isOptionsFieldUnsupported(message)) {
      return;
    }
    if (isMissingProductOptionInput(message)) {
      return;
    }
    throw new Error(message);
  }
}
