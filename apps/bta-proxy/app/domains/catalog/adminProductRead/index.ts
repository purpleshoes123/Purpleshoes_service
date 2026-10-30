// Phase 2 scaffold (READ-only)
export { fetchPublications } from "~/domains/catalog/adminProductRead/fetchPublications";
export type { PublicationDTO } from "~/domains/catalog/adminProductRead/publicationsQuery";

export {
  fetchTaxonomyNodeByPublicId,
  TRAVEL_TAXONOMY_PUBLIC_ID,
} from "~/domains/catalog/adminProductRead/fetchTaxonomy";
export type { TaxonomyNodeDTO } from "~/domains/catalog/adminProductRead/taxonomyQuery";

export { fetchProductByExternalKey } from "~/domains/catalog/adminProductRead/fetchProductByExternalKey";
export type { ProductSummaryDTO } from "~/domains/catalog/adminProductRead/externalKeyQuery";
