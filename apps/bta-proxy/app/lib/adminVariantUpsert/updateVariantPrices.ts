import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import type { VariantUpdate } from "./plan";
import { mapBulkUpdate, VARIANTS_BULK_UPDATE_MUTATION } from "./bulkUpdateQuery";

const VARIANT_UPDATE_MUTATION = `
  mutation updateVariant($input: ProductVariantInput!) {
    productVariantUpdate(input: $input) {
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

type VariantUpdateInput = { id: string; price: string };

type VariantUpdateResponse = {
  data?: {
    productVariantUpdate?: {
      productVariant?: { id?: string | null } | null;
      userErrors?: Array<{ field?: string[] | null; message?: string | null } | null> | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

function formatUserErrors(
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

function buildUpdateInputs(
  updates: VariantUpdate[],
  deactivateIds: string[]
): VariantUpdateInput[] {
  const deactivateSet = new Set(deactivateIds);

  const updateInputs = updates
    .filter((update) => !deactivateSet.has(update.id))
    .map((update) => ({
      id: update.id,
      price: String(update.price),
    }));

  const deactivateInputs = deactivateIds.map((id) => ({ id, price: "0" }));

  return [...updateInputs, ...deactivateInputs];
}

const VARIANT_PRODUCT_QUERY = `
  query getVariantProduct($id: ID!) {
    productVariant(id: $id) {
      id
      product {
        id
      }
    }
  }
`;

type VariantProductResponse = {
  data?: {
    productVariant?: {
      product?: { id?: string | null } | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

async function fetchProductIdFromVariantId(
  adminClient: AdminApiContext,
  variantId: string
): Promise<string | null> {
  const response = await adminClient.graphql(VARIANT_PRODUCT_QUERY, {
    variables: { id: variantId },
  });

  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as VariantProductResponse;
  if (json?.errors?.length) {
    return null;
  }

  const productId = json.data?.productVariant?.product?.id ?? null;
  return typeof productId === "string" && productId.length > 0 ? productId : null;
}

async function runBulkUpdate(
  adminClient: AdminApiContext,
  productId: string,
  variants: VariantUpdateInput[]
): Promise<void> {
  const response = await adminClient.graphql(VARIANTS_BULK_UPDATE_MUTATION, {
    variables: { productId, variants },
  });

  if (!response.ok) {
    throw new Error("Shopify Admin GraphQL variants bulk update 실패");
  }

  const json = await response.json();
  const result = mapBulkUpdate(json);

  if (!result.ok) {
    const message = result.errors?.join(", ") ?? "unknown error";
    throw new Error(`variants bulk update 실패: ${message}`);
  }
}

async function runSingleUpdateLoop(
  adminClient: AdminApiContext,
  variants: VariantUpdateInput[]
): Promise<void> {
  const updatedIds: string[] = [];

  for (const variant of variants) {
    const response = await adminClient.graphql(VARIANT_UPDATE_MUTATION, {
      variables: { input: variant },
    });

    if (!response.ok) {
      if (updatedIds.length > 0) {
        console.warn("variant update 부분 성공", {
          updated: updatedIds.length,
          updatedIds: updatedIds.slice(0, 20),
        });
      }
      throw new Error(`variant update 실패: updated=${updatedIds.length}`);
    }

    const json = (await response.json()) as VariantUpdateResponse;
    const errors: string[] = [];

    for (const error of json.errors ?? []) {
      if (error?.message) errors.push(error.message);
    }

    const userErrors = formatUserErrors(
      json.data?.productVariantUpdate?.userErrors ?? []
    );
    errors.push(...userErrors);

    if (errors.length > 0) {
      if (updatedIds.length > 0) {
        console.warn("variant update 부분 성공", {
          updated: updatedIds.length,
          updatedIds: updatedIds.slice(0, 20),
        });
      }
      throw new Error(
        `variant update 실패: ${errors.join(", ")} (updated=${updatedIds.length})`
      );
    }

    const updatedId = json.data?.productVariantUpdate?.productVariant?.id ?? null;
    if (typeof updatedId === "string" && updatedId.length > 0) {
      updatedIds.push(updatedId);
    } else {
      if (updatedIds.length > 0) {
        console.warn("variant update 부분 성공", {
          updated: updatedIds.length,
          updatedIds: updatedIds.slice(0, 20),
        });
      }
      throw new Error(`variant update 실패: updated=${updatedIds.length}`);
    }
  }
}

export async function updateVariantPrices(
  adminClient: AdminApiContext,
  updates: VariantUpdate[],
  deactivateIds: string[]
): Promise<void> {
  if (updates.length === 0 && deactivateIds.length === 0) {
    return;
  }

  const inputs = buildUpdateInputs(updates, deactivateIds);
  const idSample = inputs.map((input) => input.id).slice(0, 20);

  const firstId = inputs[0]?.id ?? "";
  const productId = firstId
    ? await fetchProductIdFromVariantId(adminClient, firstId)
    : null;

  if (productId) {
    try {
      await runBulkUpdate(adminClient, productId, inputs);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // bulk update 실패 시 단일 루프 fallback
      try {
        await runSingleUpdateLoop(adminClient, inputs);
        return;
      } catch (innerError) {
        const innerMessage = innerError instanceof Error ? innerError.message : String(innerError);
        throw new Error(
          `variant price update 실패: ${message}; fallback 실패: ${innerMessage}; ids=${idSample.join(",")}`
        );
      }
    }
  }

  // productId 조회 실패 시 단일 루프 fallback
  await runSingleUpdateLoop(adminClient, inputs);
}
