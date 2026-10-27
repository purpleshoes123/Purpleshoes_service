import { createHmac, timingSafeEqual } from "crypto";
import type { MailerDbClient } from "~/lib/mailer/store.shared";

const UNSUBSCRIBE_PATH = "/mail/unsubscribe";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function getUnsubscribeSecret() {
  const secret =
    process.env.MAIL_UNSUBSCRIBE_SECRET?.trim() ||
    process.env.SHOPIFY_API_SECRET?.trim() ||
    (process.env.NODE_ENV === "test" ? "mail-unsubscribe-test-secret" : "");

  if (!secret) {
    throw new Error("MAIL_UNSUBSCRIBE_SECRET is not configured");
  }

  return secret;
}

function getUnsubscribeBaseUrl() {
  const raw =
    process.env.MAIL_UNSUBSCRIBE_BASE_URL?.trim() ||
    process.env.SHOPIFY_APP_URL?.trim() ||
    "https://bta-proxy.kpurpleshoes.com";
  const url = new URL(raw);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("MAIL_UNSUBSCRIBE_BASE_URL must use http or https");
  }

  return url;
}

function createSignature(params: { shopDomain: string; sendRequestId: string }) {
  return createHmac("sha256", getUnsubscribeSecret())
    .update(
      `mail-unsubscribe-v1:${params.shopDomain}:${params.sendRequestId}`,
      "utf8"
    )
    .digest("base64url");
}

export function createMailUnsubscribeUrl(params: {
  shopDomain: string;
  sendRequestId: string;
}) {
  const url = getUnsubscribeBaseUrl();
  url.pathname = UNSUBSCRIBE_PATH;
  url.searchParams.set("rid", params.sendRequestId);
  url.searchParams.set("sig", createSignature(params));
  return url.toString();
}

export function isValidMailUnsubscribeSignature(params: {
  shopDomain: string;
  sendRequestId: string;
  signature: string | null | undefined;
}) {
  if (!params.signature) return false;

  const expected = createSignature(params);
  const actual = params.signature.trim();
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");

  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export async function isMailRecipientUnsubscribed(
  prisma: MailerDbClient,
  params: { shopDomain: string; recipientEmail: string }
) {
  const recipientEmail = normalizeEmail(params.recipientEmail);
  if (!recipientEmail) return false;

  const suppression = await prisma.mailRecipientSuppression.findUnique({
    where: {
      shopDomain_recipientEmail: {
        shopDomain: params.shopDomain,
        recipientEmail,
      },
    },
    select: { id: true },
  });

  return Boolean(suppression);
}

export async function suppressMailRecipient(
  prisma: MailerDbClient,
  params: {
    shopDomain: string;
    recipientEmail: string;
    sourceSendRequestId: string;
  }
) {
  const recipientEmail = normalizeEmail(params.recipientEmail);
  return prisma.mailRecipientSuppression.upsert({
    where: {
      shopDomain_recipientEmail: {
        shopDomain: params.shopDomain,
        recipientEmail,
      },
    },
    create: {
      shopDomain: params.shopDomain,
      recipientEmail,
      sourceSendRequestId: params.sourceSendRequestId,
    },
    update: {
      sourceSendRequestId: params.sourceSendRequestId,
      unsubscribedAt: new Date(),
    },
  });
}

type CustomerLookupResponse = {
  data?: {
    customers?: {
      nodes?: Array<{ id?: string | null }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

type CustomerConsentResponse = {
  data?: {
    customerEmailMarketingConsentUpdate?: {
      userErrors?: Array<{ message?: string }>;
    };
  };
  errors?: Array<{ message?: string }>;
};

const FIND_CUSTOMER_BY_EMAIL = `#graphql
  query FindCustomerForMailUnsubscribe($query: String!) {
    customers(first: 1, query: $query) {
      nodes {
        id
      }
    }
  }
`;

const UNSUBSCRIBE_CUSTOMER_EMAIL_MARKETING = `#graphql
  mutation CustomerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      customer {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function responseErrorMessage(
  payload: { errors?: Array<{ message?: string }> },
  fallback: string
) {
  return (
    payload.errors
      ?.map((error) => error.message || "")
      .filter(Boolean)
      .join(", ") || fallback
  );
}

/**
 * The BTA suppression table is authoritative for BTA delivery. When the
 * recipient is also a Shopify customer, mirror the opt-out into Shopify so
 * its email marketing state stays aligned. Non-members have no customer to
 * update, which is expected for the squeeze flow.
 */
export async function syncShopifyEmailMarketingUnsubscribe(params: {
  shopDomain: string;
  recipientEmail: string;
}) {
  // Keep signed-link rendering independent from Shopify app initialization.
  // This lets email rendering and link verification run in isolation, while
  // the Admin API is only loaded after a recipient actually confirms opt-out.
  const { getAdminApiClient } = await import("~/lib/shopifyAdmin");
  const admin = await getAdminApiClient(params.shopDomain);
  if (!admin) return { status: "admin_unavailable" as const };

  const recipientEmail = normalizeEmail(params.recipientEmail);
  const lookupResponse = await admin.graphql(FIND_CUSTOMER_BY_EMAIL, {
    variables: { query: `email:${recipientEmail}` },
  });
  if (!lookupResponse.ok) {
    throw new Error("Shopify customer lookup failed");
  }

  const lookup = (await lookupResponse.json()) as CustomerLookupResponse;
  if (lookup.errors?.length) {
    throw new Error(responseErrorMessage(lookup, "Shopify customer lookup failed"));
  }

  const customerId = lookup.data?.customers?.nodes?.[0]?.id || null;
  if (!customerId) return { status: "customer_not_found" as const };

  const consentResponse = await admin.graphql(
    UNSUBSCRIBE_CUSTOMER_EMAIL_MARKETING,
    {
      variables: {
        input: {
          customerId,
          emailMarketingConsent: {
            marketingState: "UNSUBSCRIBED",
            consentUpdatedAt: new Date().toISOString(),
          },
        },
      },
    }
  );
  if (!consentResponse.ok) {
    throw new Error("Shopify marketing consent update failed");
  }

  const consent = (await consentResponse.json()) as CustomerConsentResponse;
  const userErrors =
    consent.data?.customerEmailMarketingConsentUpdate?.userErrors || [];
  if (consent.errors?.length || userErrors.length) {
    throw new Error(
      [
        responseErrorMessage(consent, ""),
        ...userErrors.map((error) => error.message || "").filter(Boolean),
      ]
        .filter(Boolean)
        .join(", ") || "Shopify marketing consent update failed"
    );
  }

  return { status: "synced" as const };
}
