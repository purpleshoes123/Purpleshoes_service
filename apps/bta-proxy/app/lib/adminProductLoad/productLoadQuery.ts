export type ProductLoadBase = {
  productId: string;
  title: string;
  descriptionHtml: string;
  status?: string;
  heroMediaId?: string;
  metafields: Array<{ namespace: string; key: string; value: string | null }>;
};

export const PRODUCT_LOAD_QUERY = `
  query getProductLoad($id: ID!) {
    product(id: $id) {
      id
      title
      descriptionHtml
      status
      media(first: 1) {
        edges {
          node {
            id
          }
        }
      }
      externalKey: metafield(namespace: "travel", key: "external_key") {
        namespace
        key
        value
      }
      poolKey: metafield(namespace: "travel", key: "pool_key") {
        namespace
        key
        value
      }
      blackoutDates: metafield(namespace: "travel", key: "blackout_dates") {
        namespace
        key
        value
      }
      guideUnitsRequired: metafield(namespace: "travel", key: "guide_units_required") {
        namespace
        key
        value
      }
      bookingMode: metafield(namespace: "travel", key: "booking_mode") {
        namespace
        key
        value
      }
      startTimeLabel: metafield(namespace: "travel", key: "start_time_label") {
        namespace
        key
        value
      }
      operatingWeekdays: metafield(namespace: "travel", key: "operating_weekdays") {
        namespace
        key
        value
      }
      bookingWindowDays: metafield(namespace: "travel", key: "booking_window_days") {
        namespace
        key
        value
      }
      maxPax: metafield(namespace: "travel", key: "max_pax") {
        namespace
        key
        value
      }
      categoryImage: metafield(namespace: "tour", key: "images1") {
        namespace
        key
        value
      }
      travelGallery: metafield(namespace: "custom", key: "travel_gallery") {
        namespace
        key
        value
      }
    }
  }
`;

type ProductLoadMetafield = {
  namespace?: string | null;
  key?: string | null;
  value?: string | null;
} | null;

type ProductLoadResponse = {
  data?: {
    product?: {
      id?: string | null;
      title?: string | null;
      descriptionHtml?: string | null;
      status?: string | null;
      media?: {
        edges?: Array<{ node?: { id?: string | null } | null } | null> | null;
      } | null;
      externalKey?: ProductLoadMetafield;
      poolKey?: ProductLoadMetafield;
      blackoutDates?: ProductLoadMetafield;
      guideUnitsRequired?: ProductLoadMetafield;
      bookingMode?: ProductLoadMetafield;
      startTimeLabel?: ProductLoadMetafield;
      operatingWeekdays?: ProductLoadMetafield;
      bookingWindowDays?: ProductLoadMetafield;
      maxPax?: ProductLoadMetafield;
      categoryImage?: ProductLoadMetafield;
      travelGallery?: ProductLoadMetafield;
    } | null;
  } | null;
  errors?: Array<{ message?: string | null } | null> | null;
};

export function mapProductLoad(resp: ProductLoadResponse): ProductLoadBase {
  const product = resp?.data?.product;
  if (!product?.id) {
    throw new Error("product load 응답에서 productId를 찾을 수 없습니다.");
  }

  const metafields = [
    { namespace: "travel", key: "external_key", field: product.externalKey },
    { namespace: "travel", key: "pool_key", field: product.poolKey },
    { namespace: "travel", key: "blackout_dates", field: product.blackoutDates },
    {
      namespace: "travel",
      key: "guide_units_required",
      field: product.guideUnitsRequired,
    },
    { namespace: "travel", key: "booking_mode", field: product.bookingMode },
    {
      namespace: "travel",
      key: "start_time_label",
      field: product.startTimeLabel,
    },
    {
      namespace: "travel",
      key: "operating_weekdays",
      field: product.operatingWeekdays,
    },
    {
      namespace: "travel",
      key: "booking_window_days",
      field: product.bookingWindowDays,
    },
    { namespace: "travel", key: "max_pax", field: product.maxPax },
    { namespace: "tour", key: "images1", field: product.categoryImage },
    { namespace: "custom", key: "travel_gallery", field: product.travelGallery },
  ].map(({ namespace, key, field }) => ({
    namespace: field?.namespace ?? namespace,
    key: field?.key ?? key,
    value: field?.value ?? null,
  }));

  const heroMediaId = product.media?.edges?.[0]?.node?.id ?? undefined;

  return {
    productId: product.id,
    title: product.title ?? "",
    descriptionHtml: product.descriptionHtml ?? "",
    status: product.status ?? undefined,
    heroMediaId,
    metafields,
  };
}
