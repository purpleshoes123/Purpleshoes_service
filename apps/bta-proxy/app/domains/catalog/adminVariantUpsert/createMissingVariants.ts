import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type { VariantCreate } from "./plan";
import { mapBulkCreate, VARIANTS_BULK_CREATE_MUTATION } from "./bulkCreateQuery";

const VARIANT_CREATE_MUTATION = `
  mutation createVariant($productId: ID!, $variant: ProductVariantInput!) {
    productVariantCreate(productId: $productId, variant: $variant) {
      productVariant {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type VariantCreateInput = {
  price: string;
} & (
  | { selectedOptions: Array<{ name: string; value: string }> }
  | { options: string[] }
  | { optionValues: Array<Record<string, string>> }
);

type VariantOptionMode = "options" | "selectedOptions" | "optionValues";
type OptionValueMapping = {
  optionNameKey?: string;
  optionIdKey?: string;
  valueKey: string;
};
type BulkVariantInputSupport = {
  modes: VariantOptionMode[];
  optionValueMapping?: OptionValueMapping;
};

class VariantInputFieldUnsupportedError extends Error {
  constructor(
    public readonly mode: VariantOptionMode,
    message: string,
  ) {
    super(message);
    this.name = "VariantInputFieldUnsupportedError";
  }
}

let bulkVariantInputSupport: BulkVariantInputSupport | null = null;

type VariantCreateResponse = {
  data?: {
    productVariantCreate?: {
      productVariant?: { id?: string | null } | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null } | null> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

const TICKET_TYPE_LABELS: Record<VariantCreate["ticketType"], string> = {
  adult: "Adult",
  child: "Child",
  infant: "Infant",
};

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

async function resolveBulkVariantInputSupport(
  adminClient: AdminApiContext,
): Promise<BulkVariantInputSupport> {
  if (bulkVariantInputSupport) {
    return bulkVariantInputSupport;
  }

  const introspectionQuery = `
    query IntrospectBulkVariantInput {
      bulkInput: __type(name: "ProductVariantsBulkInput") {
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

  try {
    const response = await adminClient.graphql(introspectionQuery);
    if (!response.ok) {
      bulkVariantInputSupport = { modes: ["options", "selectedOptions"] };
      return bulkVariantInputSupport;
    }

    const json = await response.json();
    const fields: Array<{ name?: string; type?: any }> = json?.data?.bulkInput?.inputFields ?? [];
    const modes: VariantOptionMode[] = [];
    let optionValueTypeName = "";

    for (const field of fields) {
      const fieldName = field?.name ?? "";
      if (fieldName === "options") {
        modes.push("options");
      }
      if (fieldName === "selectedOptions") {
        modes.push("selectedOptions");
      }
      if (fieldName === "optionValues") {
        modes.push("optionValues");
        optionValueTypeName = unwrapTypeName(field?.type);
      }
    }

    let optionValueMapping: OptionValueMapping | undefined;
    if (optionValueTypeName) {
      const optionValueQuery = `
        query IntrospectOptionValueInput($typeName: String!) {
          optionValue: __type(name: $typeName) {
            inputFields {
              name
            }
          }
        }
      `;
      const optionValueResponse = await adminClient.graphql(optionValueQuery, {
        variables: { typeName: optionValueTypeName },
      });
      if (optionValueResponse.ok) {
        const optionValueJson = await optionValueResponse.json();
        const optionFields: Array<{ name?: string }> =
          optionValueJson?.data?.optionValue?.inputFields ?? [];
        const names = optionFields
          .map((field) => field?.name)
          .filter((name): name is string => typeof name === "string");
        const normalized = names.map((name) => ({
          raw: name,
          lower: name.toLowerCase(),
        }));
        const optionNameKey =
          normalized.find((field) => field.lower === "optionname")?.raw ||
          normalized.find((field) => field.lower === "option_name")?.raw;
        const optionIdKey =
          normalized.find((field) => field.lower === "optionid")?.raw ||
          normalized.find((field) => field.lower === "id")?.raw;
        const nameField = normalized.find((field) => field.lower === "name")?.raw;
        const valueKeyCandidate =
          normalized.find((field) => field.lower === "value")?.raw ||
          normalized.find((field) => field.lower.includes("value"))?.raw;
        const valueKey = nameField || valueKeyCandidate || "";
        if (valueKey) {
          optionValueMapping = { optionNameKey, optionIdKey, valueKey };
        } else {
          console.log(
            JSON.stringify({
              message: "variant optionValues mapping unresolved",
              optionValueTypeName,
              optionValueFields: names,
            }),
          );
        }
      }
    }

    bulkVariantInputSupport = {
      modes: modes.length > 0 ? modes : ["options", "selectedOptions"],
      optionValueMapping,
    };

    if (modes.length === 0) {
      console.log(
        JSON.stringify({
          message: "variant bulk input fields missing",
          inputFields: fields.map((field) => field?.name ?? ""),
        }),
      );
    }

    return bulkVariantInputSupport;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      JSON.stringify({
        message: "variant bulk input introspection failed",
        error: message,
      }),
    );
    bulkVariantInputSupport = { modes: ["options", "selectedOptions"] };
    return bulkVariantInputSupport;
  }
}

function buildVariantCreateInputs(creates: VariantCreate[]): VariantCreateInput[] {
  return buildsVariantCreateInputsWithMode(creates, "selectedOptions");
}

function buildsVariantCreateInputsWithMode(
  creates: VariantCreate[],
  mode: VariantOptionMode,
  optionValueMapping?: OptionValueMapping,
): VariantCreateInput[] {
  return creates.map((create) => {
    const ticketTypeValue = TICKET_TYPE_LABELS[create.ticketType];
    const paxTierValue = String(create.tier);
    if (mode === "options") {
      return {
        options: [ticketTypeValue, paxTierValue],
        price: String(create.price),
      };
    }
    if (mode === "optionValues") {
      if (!optionValueMapping?.valueKey) {
        throw new VariantInputFieldUnsupportedError("optionValues", "optionValues mapping missing");
      }
      const ticketValue: Record<string, string> = {
        [optionValueMapping.valueKey]: ticketTypeValue,
      };
      const paxValue: Record<string, string> = {
        [optionValueMapping.valueKey]: paxTierValue,
      };
      if (optionValueMapping.optionNameKey) {
        ticketValue[optionValueMapping.optionNameKey] = "Ticket Type";
        paxValue[optionValueMapping.optionNameKey] = "Pax Tier";
      }
      return {
        optionValues: [ticketValue, paxValue],
        price: String(create.price),
      };
    }
    return {
      selectedOptions: [
        { name: "Ticket Type", value: ticketTypeValue },
        { name: "Pax Tier", value: paxTierValue },
      ],
      price: String(create.price),
    };
  });
}

function formatUserErrors(
  errors: Array<{ field?: string[] | null; message?: string | null } | null>,
): string[] {
  return errors
    .filter(Boolean)
    .map((error) => {
      const field = error?.field?.filter(Boolean).join(".") ?? "";
      const message = error?.message ?? "";
      if (field && message) {
        return `${field}: ${message}`;
      }
      return message;
    })
    .filter((value) => value.length > 0);
}

function isBulkCreateUnsupported(errors: string[]): boolean {
  return errors.some(
    (message) =>
      message.includes("productVariantsBulkCreate") ||
      message.includes("ProductVariantsBulkCreate") ||
      message.includes("Unknown field") ||
      message.includes("doesn't exist"),
  );
}

function isBulkInputFieldUnsupported(message: string, mode: VariantOptionMode): boolean {
  const fieldName =
    mode === "options" ? "options" : mode === "optionValues" ? "optionValues" : "selectedOptions";
  return (
    message.includes("ProductVariantsBulkInput") &&
    message.includes(fieldName) &&
    (message.includes("Field is not defined") ||
      message.includes("doesn't accept argument") ||
      message.includes("was provided invalid value"))
  );
}

function parseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runBulkCreate(
  adminClient: AdminApiContext,
  productId: string,
  variants: VariantCreateInput[],
): Promise<string[]> {
  const response = await adminClient.graphql(VARIANTS_BULK_CREATE_MUTATION, {
    variables: { productId, variants },
  });

  if (!response.ok) {
    throw new Error("Shopify Admin GraphQL variants bulk create 실패");
  }

  const json = await response.json();
  const result = mapBulkCreate(json);

  if (result.errors?.length) {
    const errorMessage = result.errors.join(", ");
    const created = result.createdIds.length;
    if (created > 0) {
      console.warn("variants bulk create 부분 성공", {
        created,
        createdIds: result.createdIds.slice(0, 20),
      });
    }
    throw new Error(`variants bulk create 실패: ${errorMessage} (created=${created})`);
  }

  return result.createdIds;
}

async function runSingleCreateLoop(
  adminClient: AdminApiContext,
  productId: string,
  variants: VariantCreateInput[],
): Promise<string[]> {
  const createdIds: string[] = [];

  for (const variant of variants) {
    const response = await adminClient.graphql(VARIANT_CREATE_MUTATION, {
      variables: { productId, variant },
    });

    if (!response.ok) {
      throw new Error(`variant create 실패: created=${createdIds.length}`);
    }

    const json = (await response.json()) as VariantCreateResponse;
    const errors: string[] = [];

    for (const error of json.errors ?? []) {
      if (error?.message) {
        errors.push(error.message);
      }
    }

    const userErrors = formatUserErrors(json.data?.productVariantCreate?.userErrors ?? []);
    errors.push(...userErrors);

    if (errors.length > 0) {
      if (createdIds.length > 0) {
        console.warn("variant create 부분 성공", {
          created: createdIds.length,
          createdIds: createdIds.slice(0, 20),
        });
      }
      throw new Error(`variant create 실패: ${errors.join(", ")} (created=${createdIds.length})`);
    }

    const createdId = json.data?.productVariantCreate?.productVariant?.id ?? null;
    if (typeof createdId === "string" && createdId.length > 0) {
      createdIds.push(createdId);
    } else {
      if (createdIds.length > 0) {
        console.warn("variant create 부분 성공", {
          created: createdIds.length,
          createdIds: createdIds.slice(0, 20),
        });
      }
      throw new Error(`variant create 실패: created=${createdIds.length}`);
    }
  }

  return createdIds;
}

async function createMissingVariantsWithMode(
  adminClient: AdminApiContext,
  productId: string,
  creates: VariantCreate[],
  mode: VariantOptionMode,
  optionValueMapping?: OptionValueMapping,
): Promise<string[]> {
  const inputs = buildsVariantCreateInputsWithMode(creates, mode, optionValueMapping);
  let shouldChunk = false;

  try {
    return await runBulkCreate(adminClient, productId, inputs);
  } catch (error) {
    const message = parseErrorMessage(error);
    if (isBulkInputFieldUnsupported(message, mode)) {
      throw new VariantInputFieldUnsupportedError(mode, message);
    }
    if (isBulkCreateUnsupported([message])) {
      return await runSingleCreateLoop(adminClient, productId, inputs);
    }
    shouldChunk = true;
  }

  if (!shouldChunk) {
    return [];
  }

  const createdIds: string[] = [];
  const totalChunks = Math.ceil(inputs.length / 20);

  for (let i = 0; i < inputs.length; i += 20) {
    const chunk = inputs.slice(i, i + 20);
    const chunkIndex = Math.floor(i / 20) + 1;
    try {
      const ids = await runBulkCreate(adminClient, productId, chunk);
      createdIds.push(...ids);
      console.info("variants chunk create ok", {
        chunk: `${chunkIndex}/${totalChunks}`,
        chunkSize: chunk.length,
        createdSoFar: createdIds.length,
      });
    } catch (error) {
      const message = parseErrorMessage(error);
      if (isBulkInputFieldUnsupported(message, mode)) {
        throw new VariantInputFieldUnsupportedError(mode, message);
      }
      if (isBulkCreateUnsupported([message])) {
        return await runSingleCreateLoop(adminClient, productId, inputs);
      }
      if (createdIds.length > 0) {
        console.warn("variants chunk create 부분 성공", {
          created: createdIds.length,
          createdIds: createdIds.slice(0, 20),
        });
      }
      throw new Error(`variants chunk create 실패: ${message} (created=${createdIds.length})`);
    }
  }

  return createdIds;
}

export async function createMissingVariants(
  adminClient: AdminApiContext,
  productId: string,
  creates: VariantCreate[],
): Promise<string[]> {
  if (creates.length === 0) {
    return [];
  }

  const support = await resolveBulkVariantInputSupport(adminClient);
  const modes =
    support.modes.length > 0
      ? support.modes
      : (["options", "selectedOptions"] as VariantOptionMode[]);
  let lastError: Error | null = null;

  for (const mode of modes) {
    try {
      return await createMissingVariantsWithMode(
        adminClient,
        productId,
        creates,
        mode,
        support.optionValueMapping,
      );
    } catch (error) {
      if (error instanceof VariantInputFieldUnsupportedError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}
