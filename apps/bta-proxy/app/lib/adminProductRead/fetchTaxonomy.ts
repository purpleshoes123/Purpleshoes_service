import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { GraphqlQueryError } from "@shopify/shopify-api";

import {
  mapTaxonomyNode,
  TAXONOMY_BY_PUBLIC_ID_QUERY,
  type TaxonomyNodeDTO,
} from "~/lib/adminProductRead/taxonomyQuery";

export const TRAVEL_TAXONOMY_PUBLIC_ID =
  process.env.TRAVEL_TAXONOMY_PUBLIC_ID;
export const TRAVEL_TAXONOMY_SEARCH =
  process.env.TRAVEL_TAXONOMY_SEARCH;
export const TRAVEL_TAXONOMY_NODE_ID =
  process.env.TRAVEL_TAXONOMY_NODE_ID;
export const TRAVEL_TAXONOMY_NAME =
  process.env.TRAVEL_TAXONOMY_NAME;
const TRAVEL_TAXONOMY_DEBUG =
  process.env.TRAVEL_TAXONOMY_DEBUG === "1";

const DEFAULT_TAXONOMY_PUBLIC_ID = "se-4-4";
let didLogLeafCandidates = false;
let taxonomyCategoryFieldConfig:
  | {
      hasPublicId: boolean;
      hasProductTaxonomyNodeId: boolean;
      hasProductTaxonomyNode: boolean;
    }
  | null = null;

type TaxonomyCategoryNode = {
  id?: string;
  name?: string;
  fullName?: string;
  isLeaf?: boolean;
  isRoot?: boolean;
  publicId?: string;
  productTaxonomyNodeId?: string;
  productTaxonomyNode?: {
    id?: string;
    name?: string;
    fullName?: string;
    isLeaf?: boolean;
    isRoot?: boolean;
  };
};

export async function fetchTaxonomyNodeByPublicId(
  adminClient: AdminApiContext,
  publicId: string
): Promise<TaxonomyNodeDTO> {
  console.log(
    JSON.stringify({
      message: "fetchTaxonomyNodeByPublicId called",
      publicId,
    })
  );
  const expectedPublicId =
    TRAVEL_TAXONOMY_PUBLIC_ID || DEFAULT_TAXONOMY_PUBLIC_ID;
  const searchCandidates = Array.from(
    new Set(
      [
        TRAVEL_TAXONOMY_SEARCH,
        TRAVEL_TAXONOMY_NAME,
        publicId,
      ].filter((value): value is string => Boolean(value && value.trim()))
    )
  );
  const queryCandidates = Array.from(
    new Set([
      ...searchCandidates,
      `public_id:${publicId}`,
      `publicId:${publicId}`,
      `id:${publicId}`,
      publicId,
    ])
  );
  let lastErrorMessage = "";
  let didIntrospect = false;

  for (const query of queryCandidates) {
    let response: Response;
    try {
      response = await adminClient.graphql(TAXONOMY_BY_PUBLIC_ID_QUERY, {
        variables: { search: query, first: 10 },
      });
    } catch (error) {
      const parsedErrors = extractGraphqlErrors(error);
      const parsedMessage = parsedErrors
        .map((parsedError) => parsedError.message)
        .filter(Boolean)
        .join(", ");
      const errorMessage =
        parsedMessage ||
        (error instanceof Error ? error.message : String(error));
      console.log(
        JSON.stringify({
          message: "taxonomy query failed",
          publicId,
          query,
          error: errorMessage,
        })
      );
      if (parsedErrors.length > 0) {
        lastErrorMessage = parsedMessage;
        if (
          TRAVEL_TAXONOMY_DEBUG &&
          !didIntrospect &&
          hasMissingQueryRootField(parsedErrors)
        ) {
          didIntrospect = true;
          await logQueryRootTaxonomyFields(adminClient, publicId);
        }
      } else {
        lastErrorMessage = errorMessage;
      }
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `카테고리 조회 실패: Shopify Admin GraphQL 요청 실패 (publicId=${publicId})`
      );
    }

    const rawText = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(rawText);
    } catch (error) {
      console.log(
        JSON.stringify({
          message: "taxonomy query response parse failed",
          publicId,
          search: query,
          status: response.status,
          ok: response.ok,
          rawTextSample: rawText.slice(0, 500),
          error: error instanceof Error ? error.message : String(error),
        })
      );
      throw new Error(
        `카테고리 조회 실패: Shopify Admin GraphQL 응답 파싱 실패 (publicId=${publicId})`
      );
    }

    if (TRAVEL_TAXONOMY_DEBUG) {
      const categoryEdges = Array.isArray(
        json?.data?.taxonomy?.categories?.edges
      )
        ? json.data.taxonomy.categories.edges
        : [];
      const sampleNode = categoryEdges[0]?.node ?? null;
      console.log(
        JSON.stringify({
          message: "taxonomy query response",
          publicId,
          query,
          status: response.status,
          ok: response.ok,
          errorCount: Array.isArray(json?.errors) ? json.errors.length : 0,
          categoriesCount: categoryEdges.length,
          sampleNode,
        })
      );
    }
    if (json?.errors?.length) {
      lastErrorMessage = json.errors
        .map((error: { message?: string }) => error.message)
        .filter(Boolean)
        .join(", ");
      console.log(
        JSON.stringify({
          message: "taxonomy query failed",
          publicId,
          query,
          error: lastErrorMessage,
        })
      );
      if (
        TRAVEL_TAXONOMY_DEBUG &&
        !didIntrospect &&
        hasMissingQueryRootField(json.errors)
      ) {
        didIntrospect = true;
        await logQueryRootTaxonomyFields(adminClient, publicId);
      }
      continue;
    }

    const node = mapTaxonomyNode(json, publicId, query);
    if (node) {
      if (TRAVEL_TAXONOMY_DEBUG && node.id) {
        await maybeLogLeafCandidates(
          adminClient,
          node.id,
          publicId,
          "search",
          query
        );
      }
      console.log(
        JSON.stringify({
          message: "taxonomy node resolved",
          publicId,
          nodeId: node.id,
          name: node.name,
        })
      );
      return node;
    }
  }

  if (TRAVEL_TAXONOMY_NODE_ID && publicId === expectedPublicId) {
    console.log(
      JSON.stringify({
        message: "taxonomy node id override applied",
        publicId,
      })
    );
    if (TRAVEL_TAXONOMY_DEBUG) {
      await maybeLogLeafCandidates(
        adminClient,
        TRAVEL_TAXONOMY_NODE_ID,
        publicId,
        "override"
      );
    }
    console.log(
      JSON.stringify({
        message: "taxonomy node resolved",
        publicId,
        nodeId: TRAVEL_TAXONOMY_NODE_ID,
        name: TRAVEL_TAXONOMY_NAME || expectedPublicId,
      })
    );
    return {
      id: TRAVEL_TAXONOMY_NODE_ID,
      name: TRAVEL_TAXONOMY_NAME || expectedPublicId,
      publicId: expectedPublicId,
    };
  }

  if (lastErrorMessage) {
    throw new Error(
      `카테고리 조회 실패: ${lastErrorMessage} (publicId=${publicId})`
    );
  }

  throw new Error(`카테고리 조회 실패: publicId=${publicId}`);
}

function hasMissingQueryRootField(
  errors: Array<{ message?: string | null } | null>
): boolean {
  return errors.some((error) => {
    const message = error?.message || "";
    return (
      message.includes("doesn't exist on type 'QueryRoot'") ||
      message.includes("doesn't exist on type \"QueryRoot\"")
    );
  });
}

function extractGraphqlErrors(
  error: unknown
): Array<{ message?: string | null }> {
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

function formatTypeRef(type: any): string {
  if (!type) return "";
  if (type.kind === "NON_NULL") return `${formatTypeRef(type.ofType)}!`;
  if (type.kind === "LIST") return `[${formatTypeRef(type.ofType)}]`;
  return type.name || "";
}

function unwrapTypeName(type: any): string {
  if (!type) return "";
  if (type.name) return type.name;
  if (type.ofType) return unwrapTypeName(type.ofType);
  return "";
}

async function maybeLogLeafCandidates(
  adminClient: AdminApiContext,
  parentId: string,
  publicId: string,
  source: string,
  query?: string
): Promise<void> {
  if (!TRAVEL_TAXONOMY_DEBUG) return;
  if (!parentId) return;
  if (didLogLeafCandidates) return;
  await logLeafCategoryCandidates(
    adminClient,
    parentId,
    publicId,
    source,
    query
  );
  didLogLeafCandidates = true;
}

function normalizeSegment(value: string): string {
  return value.trim().toLowerCase();
}

function getTaxonomyPathSegments(): string[] {
  const raw =
    TRAVEL_TAXONOMY_SEARCH || TRAVEL_TAXONOMY_NAME || "";
  if (!raw) return [];
  if (raw.includes(">")) {
    return raw
      .split(">")
      .map((segment) => segment.trim())
      .filter(Boolean);
  }
  return [raw.trim()].filter(Boolean);
}

async function resolveTaxonomyCategoryFieldConfig(
  adminClient: AdminApiContext,
  publicId: string
): Promise<{
  hasPublicId: boolean;
  hasProductTaxonomyNodeId: boolean;
  hasProductTaxonomyNode: boolean;
}> {
  if (taxonomyCategoryFieldConfig) {
    return taxonomyCategoryFieldConfig;
  }

  const details = await introspectTypeDetails(
    adminClient,
    "TaxonomyCategory",
    publicId
  );
  const fieldNames = new Set(
    (details?.fields || []).map((field) => field.name)
  );
  taxonomyCategoryFieldConfig = {
    hasPublicId: fieldNames.has("publicId"),
    hasProductTaxonomyNodeId: fieldNames.has("productTaxonomyNodeId"),
    hasProductTaxonomyNode: fieldNames.has("productTaxonomyNode"),
  };
  return taxonomyCategoryFieldConfig;
}

function buildTaxonomyCategorySelection(config: {
  hasPublicId: boolean;
  hasProductTaxonomyNodeId: boolean;
  hasProductTaxonomyNode: boolean;
}): string {
  const fields = ["id", "name", "fullName", "isLeaf", "isRoot"];
  if (config.hasPublicId) {
    fields.push("publicId");
  }
  if (config.hasProductTaxonomyNodeId) {
    fields.push("productTaxonomyNodeId");
  }
  if (config.hasProductTaxonomyNode) {
    fields.push(
      `productTaxonomyNode { id name fullName isLeaf isRoot }`
    );
  }
  return fields.join("\n");
}

function extractProductTaxonomyNodeId(
  node: TaxonomyCategoryNode
): string | undefined {
  if (typeof node.productTaxonomyNodeId === "string") {
    return node.productTaxonomyNodeId;
  }
  if (typeof node.productTaxonomyNode?.id === "string") {
    return node.productTaxonomyNode.id;
  }
  return undefined;
}

function formatTaxonomyCandidate(
  node: TaxonomyCategoryNode
): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    fullName: node.fullName,
    isLeaf: node.isLeaf,
    isRoot: node.isRoot,
    publicId: node.publicId,
    productTaxonomyNodeId: extractProductTaxonomyNodeId(node),
    productTaxonomyNode: node.productTaxonomyNode
      ? {
          id: node.productTaxonomyNode.id,
          name: node.productTaxonomyNode.name,
          fullName: node.productTaxonomyNode.fullName,
          isLeaf: node.productTaxonomyNode.isLeaf,
          isRoot: node.productTaxonomyNode.isRoot,
        }
      : undefined,
  };
}

function findCategoryMatch(
  nodes: TaxonomyCategoryNode[],
  segment: string
): TaxonomyCategoryNode | undefined {
  const normalizedSegment = normalizeSegment(segment);
  return (
    nodes.find(
      (node) => normalizeSegment(node.name || "") === normalizedSegment
    ) ||
    nodes.find((node) =>
      normalizeSegment(node.fullName || "").endsWith(normalizedSegment)
    ) ||
    nodes.find((node) =>
      normalizeSegment(node.fullName || "").includes(normalizedSegment)
    )
  );
}

async function logQueryRootTaxonomyFields(
  adminClient: AdminApiContext,
  publicId: string
): Promise<void> {
  console.log(
    JSON.stringify({
      message: "Taxonomy introspection start",
      publicId,
    })
  );
  const introspectionQuery = `
    query IntrospectQueryRoot {
      queryRoot: __type(name: "QueryRoot") {
        fields {
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
                }
              }
            }
          }
        }
      }
      productCategory: __type(name: "ProductCategory") {
        name
        fields { name }
      }
      productTaxonomyNode: __type(name: "ProductTaxonomyNode") {
        name
        fields { name }
      }
      taxonomyNode: __type(name: "TaxonomyNode") {
        name
        fields { name }
      }
    }
  `;

  try {
    const response = await adminClient.graphql(introspectionQuery);
    if (!response.ok) {
      console.log(
        JSON.stringify({
          message: "Taxonomy introspection failed",
          reason: "response_not_ok",
          publicId,
        })
      );
      return;
    }

    const json = await response.json();
    if (json?.errors?.length) {
      const errorMessage = json.errors
        .map((error: { message?: string }) => error.message)
        .filter(Boolean)
        .join(", ");
      console.log(
        JSON.stringify({
          message: "Taxonomy introspection failed",
          reason: errorMessage || "graphql_errors",
          publicId,
        })
      );
      return;
    }

    const fields = json?.data?.queryRoot?.fields ?? [];
    const filtered = fields.filter((field: any) =>
      /tax|category/i.test(field?.name || "")
    );
    const summary = filtered.map((field: any) => ({
      name: field?.name ?? "",
      type: formatTypeRef(field?.type),
      args: Array.isArray(field?.args)
        ? field.args.map((arg: any) => ({
            name: arg?.name ?? "",
            type: formatTypeRef(arg?.type),
          }))
        : [],
    }));
    const taxonomyField = fields.find(
      (field: any) => field?.name === "taxonomy"
    );
    const taxonomyTypeName = unwrapTypeName(taxonomyField?.type);
    const taxonomyTypeDetails = taxonomyTypeName
      ? await introspectTypeDetails(adminClient, taxonomyTypeName, publicId)
      : null;

    console.log(
      JSON.stringify({
        message: "Taxonomy QueryRoot candidates",
        publicId,
        queryRootCandidates: summary,
        taxonomyTypeName,
        taxonomyTypeDetails,
        productCategoryType: json?.data?.productCategory ?? null,
        productTaxonomyNodeType: json?.data?.productTaxonomyNode ?? null,
        taxonomyNodeType: json?.data?.taxonomyNode ?? null,
      })
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "Taxonomy introspection failed",
        reason: error instanceof Error ? error.message : String(error),
        publicId,
      })
    );
  }
}

async function logLeafCategoryCandidates(
  adminClient: AdminApiContext,
  parentId: string,
  publicId: string,
  source: string,
  query?: string,
  allowFallback = true
): Promise<void> {
  const categoryConfig = await resolveTaxonomyCategoryFieldConfig(
    adminClient,
    publicId
  );
  const selection = buildTaxonomyCategorySelection(categoryConfig);
  console.log(
    JSON.stringify({
      message: "taxonomy leaf lookup start",
      publicId,
      parentId,
      source,
      query,
    })
  );
  const leafQuery = `
    query LeafTaxonomyCandidates($parentId: ID!) {
      taxonomy {
        descendants: categories(first: 100, descendantsOf: $parentId) {
          edges {
            node {
              ${selection}
            }
          }
        }
        children: categories(first: 100, childrenOf: $parentId) {
          edges {
            node {
              ${selection}
            }
          }
        }
      }
    }
  `;

  try {
    const response = await adminClient.graphql(leafQuery, {
      variables: { parentId },
    });
    if (!response.ok) {
      console.log(
        JSON.stringify({
          message: "taxonomy leaf lookup failed",
          reason: "response_not_ok",
          publicId,
          parentId,
          source,
          query,
        })
      );
      return;
    }

    const json = await response.json();
    if (json?.errors?.length) {
      const errorMessage = json.errors
        .map((error: { message?: string }) => error.message)
        .filter(Boolean)
        .join(", ");
      console.log(
        JSON.stringify({
          message: "taxonomy leaf lookup failed",
          reason: errorMessage || "graphql_errors",
          publicId,
          parentId,
          source,
          query,
        })
      );
      if (allowFallback && /invalid id/i.test(errorMessage)) {
        await logTaxonomyTreeCandidates(
          adminClient,
          publicId,
          parentId,
          source
        );
      }
      return;
    }

    const descendantsEdges = Array.isArray(
      json?.data?.taxonomy?.descendants?.edges
    )
      ? json.data.taxonomy.descendants.edges
      : [];
    const childrenEdges = Array.isArray(json?.data?.taxonomy?.children?.edges)
      ? json.data.taxonomy.children.edges
      : [];
    const allNodes = [...descendantsEdges, ...childrenEdges]
      .map((edge: any) => edge?.node)
      .filter(Boolean);
    const uniqueNodes = new Map<string, any>();
    for (const node of allNodes) {
      if (node?.id && !uniqueNodes.has(node.id)) {
        uniqueNodes.set(node.id, node);
      }
    }
    const dedupedNodes = Array.from(uniqueNodes.values());
    const leafNodes = dedupedNodes.filter(
      (node: any) => node && node.isLeaf !== false
    );
    const leafCandidates = leafNodes
      .map((node: TaxonomyCategoryNode) => formatTaxonomyCandidate(node))
      .slice(0, 100);
    const leafIds = leafCandidates
      .map((candidate) => {
        if (
          candidate &&
          typeof candidate === "object" &&
          "productTaxonomyNodeId" in candidate
        ) {
          return (candidate as any).productTaxonomyNodeId as
            | string
            | undefined;
        }
        return undefined;
      })
      .filter(Boolean);

    console.log(
      JSON.stringify({
        message: "taxonomy leaf candidates",
        publicId,
        parentId,
        source,
        query,
        descendantsCount: descendantsEdges.length,
        childrenCount: childrenEdges.length,
        uniqueCount: dedupedNodes.length,
        leafCount: leafCandidates.length,
        leafIds: leafIds.length
          ? leafIds
          : leafCandidates.map((node) => (node as any).id),
        candidates: leafCandidates,
      })
    );
  } catch (error) {
    const parsedErrors = extractGraphqlErrors(error);
    const parsedMessage = parsedErrors
      .map((parsedError) => parsedError?.message)
      .filter(Boolean)
      .join(", ");
    const errorMessage =
      parsedMessage || (error instanceof Error ? error.message : String(error));
    console.log(
      JSON.stringify({
        message: "taxonomy leaf lookup failed",
        reason: errorMessage,
        publicId,
        parentId,
        source,
        query,
      })
    );
    if (allowFallback && /invalid id/i.test(errorMessage)) {
      await logTaxonomyTreeCandidates(adminClient, publicId, parentId, source);
    }
  }
}

async function fetchTaxonomyCategories(
  adminClient: AdminApiContext,
  selection: string,
  variables: {
    first: number;
    search?: string | null;
    childrenOf?: string | null;
    descendantsOf?: string | null;
  }
): Promise<{
  nodes: TaxonomyCategoryNode[];
  errorMessage?: string;
}> {
  const categoriesQuery = `
    query TaxonomyCategories(
      $first: Int!,
      $search: String,
      $childrenOf: ID,
      $descendantsOf: ID
    ) {
      taxonomy {
        categories(
          first: $first,
          search: $search,
          childrenOf: $childrenOf,
          descendantsOf: $descendantsOf
        ) {
          edges {
            node {
              ${selection}
            }
          }
        }
      }
    }
  `;

  try {
    const response = await adminClient.graphql(categoriesQuery, {
      variables,
    });
    if (!response.ok) {
      return { nodes: [], errorMessage: "response_not_ok" };
    }
    const json = await response.json();
    if (json?.errors?.length) {
      const errorMessage = json.errors
        .map((error: { message?: string }) => error.message)
        .filter(Boolean)
        .join(", ");
      return { nodes: [], errorMessage: errorMessage || "graphql_errors" };
    }
    const edges = Array.isArray(json?.data?.taxonomy?.categories?.edges)
      ? json.data.taxonomy.categories.edges
      : [];
    const nodes = edges
      .map((edge: any) => edge?.node)
      .filter(Boolean) as TaxonomyCategoryNode[];
    return { nodes };
  } catch (error) {
    return {
      nodes: [],
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

async function logTaxonomyTreeCandidates(
  adminClient: AdminApiContext,
  publicId: string,
  parentId: string,
  source: string
): Promise<void> {
  const segments = getTaxonomyPathSegments();
  console.log(
    JSON.stringify({
      message: "taxonomy path lookup start",
      publicId,
      parentId,
      source,
      segments,
    })
  );
  const categoryConfig = await resolveTaxonomyCategoryFieldConfig(
    adminClient,
    publicId
  );
  const selection = buildTaxonomyCategorySelection(categoryConfig);

  const rootResult = await fetchTaxonomyCategories(adminClient, selection, {
    first: 100,
  });
  if (rootResult.errorMessage) {
    console.log(
      JSON.stringify({
        message: "taxonomy root lookup failed",
        publicId,
        parentId,
        source,
        reason: rootResult.errorMessage,
      })
    );
    return;
  }

  const rootCandidates = rootResult.nodes
    .map((node) => formatTaxonomyCandidate(node))
    .slice(0, 50);
  console.log(
    JSON.stringify({
      message: "taxonomy root candidates",
      publicId,
      parentId,
      source,
      count: rootResult.nodes.length,
      candidates: rootCandidates,
    })
  );

  if (segments.length === 0) {
    console.log(
      JSON.stringify({
        message: "taxonomy path missing",
        publicId,
        parentId,
        source,
      })
    );
    return;
  }

  let currentNodes = rootResult.nodes;
  let currentParentId: string | undefined;

  for (const segment of segments) {
    const matched = findCategoryMatch(currentNodes, segment);
    console.log(
      JSON.stringify({
        message: "taxonomy path segment",
        publicId,
        parentId,
        source,
        segment,
        matched: matched ? formatTaxonomyCandidate(matched) : null,
        candidates: currentNodes
          .map((node) => formatTaxonomyCandidate(node))
          .slice(0, 50),
      })
    );
    if (!matched?.id) {
      return;
    }
    currentParentId = matched.id;
    const childrenResult = await fetchTaxonomyCategories(
      adminClient,
      selection,
      {
        first: 100,
        childrenOf: currentParentId,
      }
    );
    if (childrenResult.errorMessage) {
      console.log(
        JSON.stringify({
          message: "taxonomy children lookup failed",
          publicId,
          parentId,
          source,
          segment,
          matchedId: currentParentId,
          reason: childrenResult.errorMessage,
        })
      );
      return;
    }
    currentNodes = childrenResult.nodes;
  }

  if (currentParentId) {
    await logLeafCategoryCandidates(
      adminClient,
      currentParentId,
      publicId,
      "path",
      segments.join(" > "),
      false
    );
  }
}

async function introspectTypeDetails(
  adminClient: AdminApiContext,
  typeName: string,
  publicId: string
): Promise<
  | {
      name: string;
      kind: string;
      fields: Array<{ name: string; type: string; args: string[] }>;
    }
  | null
> {
  const typeQuery = `
    query IntrospectType($typeName: String!) {
      type: __type(name: $typeName) {
        name
        kind
        fields {
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
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await adminClient.graphql(typeQuery, {
      variables: { typeName },
    });
    if (!response.ok) {
      console.log(
        JSON.stringify({
          message: "Taxonomy type introspection failed",
          reason: "response_not_ok",
          publicId,
          typeName,
        })
      );
      return null;
    }

    const json = await response.json();
    if (json?.errors?.length) {
      const errorMessage = json.errors
        .map((error: { message?: string }) => error.message)
        .filter(Boolean)
        .join(", ");
      console.log(
        JSON.stringify({
          message: "Taxonomy type introspection failed",
          reason: errorMessage || "graphql_errors",
          publicId,
          typeName,
        })
      );
      return null;
    }

    const type = json?.data?.type ?? null;
    if (!type?.name) {
      return null;
    }

    const fields = Array.isArray(type.fields)
      ? type.fields.map((field: any) => ({
          name: field?.name ?? "",
          type: formatTypeRef(field?.type),
          args: Array.isArray(field?.args)
            ? field.args.map((arg: any) => {
                const argType = formatTypeRef(arg?.type);
                return argType ? `${arg?.name ?? ""}: ${argType}` : "";
              })
            : [],
        }))
      : [];

    return {
      name: type.name,
      kind: type.kind ?? "",
      fields,
    };
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "Taxonomy type introspection failed",
        reason: error instanceof Error ? error.message : String(error),
        publicId,
        typeName,
      })
    );
    return null;
  }
}
