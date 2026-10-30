import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { GraphqlQueryError } from "@shopify/shopify-api";

import type {
  DraftCreateInput,
  DraftCreateResult,
} from "~/domains/catalog/adminProductWriteDraft/types";
import {
  PRODUCT_CREATE_MUTATION,
  mapProductCreate,
} from "~/domains/catalog/adminProductWriteDraft/productCreateQuery";
import {
  TRAVEL_TAXONOMY_PUBLIC_ID,
  fetchTaxonomyNodeByPublicId,
} from "~/domains/catalog/adminProductRead/fetchTaxonomy";
import { generateHandleCandidate } from "~/domains/catalog/adminProductUpsert/normalize";
import {
  buildCategoryInput,
  resolveCreateCategoryField,
} from "~/domains/catalog/adminProductCategory/resolveCategoryInput";

const DEFAULT_TAXONOMY_PUBLIC_ID = "se-4-4";
const MAX_HANDLE_RETRIES = 3;

type ProductCreateUserError = { field?: string[]; message?: string };

function isHandleConflict(userErrors: ProductCreateUserError[]): boolean {
  return userErrors.some((error) => {
    const message = (error.message || "").toLowerCase();
    return message.includes("handle") && message.includes("taken");
  });
}

function formatUserErrors(userErrors: ProductCreateUserError[]): string {
  return userErrors
    .map((error) => error.message)
    .filter(Boolean)
    .join(", ");
}

export async function createDraftProductBase(
  adminClient: AdminApiContext,
  input: DraftCreateInput,
): Promise<DraftCreateResult> {
  const taxonomyPublicId =
    input.taxonomyPublicId || TRAVEL_TAXONOMY_PUBLIC_ID || DEFAULT_TAXONOMY_PUBLIC_ID;
  const taxonomyNode = await fetchTaxonomyNodeByPublicId(adminClient, taxonomyPublicId);
  if (!taxonomyNode.id) {
    throw new Error(
      `카테고리 조회 실패: productTaxonomyNodeId 누락 (publicId=${taxonomyPublicId})`,
    );
  }
  const timestamp = Date.now();

  for (let attempt = 0; attempt <= MAX_HANDLE_RETRIES; attempt += 1) {
    const suffix = attempt === 0 ? undefined : attempt + 1;
    const handleCandidate = generateHandleCandidate(input.title, timestamp, suffix);

    const productInput: Record<string, unknown> = {
      title: input.title,
      descriptionHtml: input.descriptionHtml,
      status: "DRAFT",
      handle: handleCandidate,
    };
    const categoryField = await resolveCreateCategoryField(adminClient);
    if (!categoryField) {
      throw new Error(
        `카테고리 입력 필드가 ProductCreateInput에 없습니다. (publicId=${taxonomyPublicId})`,
      );
    }
    Object.assign(productInput, buildCategoryInput(categoryField, taxonomyNode.id));

    let response: Response;
    try {
      response = await adminClient.graphql(PRODUCT_CREATE_MUTATION, {
        variables: {
          input: productInput,
        },
      });
    } catch (error) {
      const parsedErrors = extractGraphqlErrors(error);
      console.log(
        JSON.stringify({
          message: "productCreate graphql threw",
          externalKey: input.externalKey,
          title: input.title,
          handleCandidate,
          parsedErrors,
          error: serializeError(error),
        }),
      );
      const errorMessage =
        parsedErrors
          .map((parsedError) => parsedError?.message)
          .filter(Boolean)
          .join(", ") || (error instanceof Error ? error.message : String(error));
      throw new Error(
        `Draft 생성 실패: ${errorMessage} (externalKey=${input.externalKey}, title=${input.title}, handleCandidate=${handleCandidate})`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Draft 생성 실패: Shopify Admin GraphQL 요청 실패 (externalKey=${input.externalKey}, title=${input.title}, handleCandidate=${handleCandidate})`,
      );
    }

    const json = await response.json();
    const userErrors: ProductCreateUserError[] = json?.data?.productCreate?.userErrors || [];

    if (userErrors.length > 0) {
      console.log(
        JSON.stringify({
          message: "productCreate userErrors",
          externalKey: input.externalKey,
          title: input.title,
          handleCandidate,
          userErrors,
        }),
      );
      if (isHandleConflict(userErrors) && attempt < MAX_HANDLE_RETRIES) {
        continue;
      }

      const errorMessage = formatUserErrors(userErrors) || "userErrors";
      throw new Error(
        `Draft 생성 실패: ${errorMessage} (externalKey=${input.externalKey}, title=${input.title}, handleCandidate=${handleCandidate})`,
      );
    }

    if (json?.errors?.length) {
      console.log(
        JSON.stringify({
          message: "productCreate graphql errors",
          externalKey: input.externalKey,
          title: input.title,
          handleCandidate,
          errors: json.errors,
        }),
      );
      const errorMessage = json.errors
        .map((error: { message?: string }) => error.message)
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `Draft 생성 실패: ${errorMessage} (externalKey=${input.externalKey}, title=${input.title}, handleCandidate=${handleCandidate})`,
      );
    }

    const result = mapProductCreate(json);
    if (!result.productId) {
      throw new Error(
        `Draft 생성 실패: productId 누락 (externalKey=${input.externalKey}, title=${input.title}, handleCandidate=${handleCandidate})`,
      );
    }

    return result;
  }

  throw new Error(
    `Draft 생성 실패: handle 충돌 재시도 초과 (externalKey=${input.externalKey}, title=${input.title})`,
  );
}

function extractGraphqlErrors(error: unknown): Array<{ message?: string | null }> {
  if (error instanceof GraphqlQueryError) {
    const graphQLErrors = error.body?.errors?.graphQLErrors ?? null;
    if (Array.isArray(graphQLErrors)) {
      return graphQLErrors;
    }
    const errors = error.body?.errors ?? null;
    if (Array.isArray(errors)) {
      return errors;
    }
  }
  const bodyErrors = (error as any)?.body?.errors ?? null;
  if (Array.isArray(bodyErrors)) {
    return bodyErrors;
  }
  const graphQLErrors = (error as any)?.body?.errors?.graphQLErrors ?? null;
  if (Array.isArray(graphQLErrors)) {
    return graphQLErrors;
  }
  return [];
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      body: (error as any)?.body ?? null,
      response: (error as any)?.response ?? null,
    };
  }
  return { message: String(error) };
}
