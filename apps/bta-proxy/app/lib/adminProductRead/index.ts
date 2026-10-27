// Phase 2 scaffold (READ-only)
export { fetchPublications } from "~/lib/adminProductRead/fetchPublications";
export type { PublicationDTO } from "~/lib/adminProductRead/publicationsQuery";

export {
  fetchTaxonomyNodeByPublicId,
  TRAVEL_TAXONOMY_PUBLIC_ID,
} from "~/lib/adminProductRead/fetchTaxonomy";
export type { TaxonomyNodeDTO } from "~/lib/adminProductRead/taxonomyQuery";

export { fetchProductByExternalKey } from "~/lib/adminProductRead/fetchProductByExternalKey";
export type { ProductSummaryDTO } from "~/lib/adminProductRead/externalKeyQuery";