import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useLoaderData, useLocation } from "react-router";
import { Badge, BlockStack, Button, Card, InlineStack, Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import { listSendRequests } from "~/domains/mail/sendRequestStore.server.ts";
import { getMailerSettingsSnapshot } from "~/domains/mail/settings.server.ts";
import { MAILER_ROUTE_PATHS, MAILER_TEMPLATE_VARIABLES } from "~/domains/mail/contracts";
import { listTemplateSummaries } from "~/domains/mail/templateStore.server.ts";
import { withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const snapshot = await getMailerSettingsSnapshot({
    shopDomain: auth.session.shop,
    prisma: db,
  });
  const [templates, logs] = await Promise.all([
    listTemplateSummaries(db, {
      shopDomain: auth.session.shop,
      limit: 5,
    }),
    listSendRequests(db, {
      shopDomain: auth.session.shop,
      limit: 5,
    }),
  ]);

  return json({
    snapshot,
    routes: {
      storefrontAlias: MAILER_ROUTE_PATHS.storefrontAlias,
      proxyRequest: MAILER_ROUTE_PATHS.proxyRequest,
    },
    variables: MAILER_TEMPLATE_VARIABLES,
    preview: {
      templates: templates.items.map((item) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        isActive: item.isActive,
        attachmentCount: item.attachmentCount,
        updatedAt: item.updatedAt.toISOString(),
      })),
      logs: logs.items.map((item) => ({
        id: item.id,
        status: item.status,
        recipientEmail: item.maskedRecipientEmail,
        pagePath: item.pagePath || "-",
        createdAt: item.createdAt.toISOString(),
      })),
    },
  });
};

function formatStatusLabel(status: string) {
  switch (status) {
    case "SEND_READY":
      return "Send Ready";
    case "RUNTIME_PENDING":
      return "Runtime Pending";
    default:
      return "Needs Config";
  }
}

function formatStatusTone(status: string) {
  switch (status) {
    case "SEND_READY":
      return "success" as const;
    case "RUNTIME_PENDING":
      return "attention" as const;
    default:
      return "critical" as const;
  }
}

function formatTimestamp(value: string | null) {
  return value ? value.replace(".000Z", "Z").replace("T", " ") : "none";
}

export default function MailHomePage() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const statusLabel = formatStatusLabel(data.snapshot.diagnostics.status);
  const statusTone = formatStatusTone(data.snapshot.diagnostics.status);

  return (
    <Page>
      <TitleBar title="Mail" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            Mail
          </Text>
          <InlineStack gap="200">
            <Button url={toInApp(MAILER_ROUTE_PATHS.adminTemplates)}>Templates</Button>
            <Button url={toInApp(MAILER_ROUTE_PATHS.adminLogs)}>Logs</Button>
            <Button url={toInApp(MAILER_ROUTE_PATHS.adminSettings)}>Settings</Button>
          </InlineStack>
        </InlineStack>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Runtime Status
              </Text>
              <Badge tone={statusTone}>{statusLabel}</Badge>
            </InlineStack>
            <Text as="p" variant="bodyMd">
              {data.snapshot.diagnostics.summary}
            </Text>
            <Text as="p" variant="bodyMd">
              Shop scope: {data.snapshot.shopDomain}
            </Text>
            <Text as="p" variant="bodyMd">
              Provider status: env {data.snapshot.envConfigured ? "ready" : "missing"} / runtime{" "}
              {data.snapshot.runtimeReady ? "ready" : "pending"}
            </Text>
            <Text as="p" variant="bodyMd">
              Recent {data.snapshot.activity.recentWindowHours}h: requests{" "}
              {data.snapshot.activity.recentRequestCount} / sent{" "}
              {data.snapshot.activity.recentSentCount} / failed{" "}
              {data.snapshot.activity.recentFailedCount} / blocked{" "}
              {data.snapshot.activity.recentBlockedCount}
            </Text>
            <Text as="p" variant="bodyMd">
              Last sent: {formatTimestamp(data.snapshot.activity.lastSentAt)} / last failed:{" "}
              {formatTimestamp(data.snapshot.activity.lastFailedAt)}
            </Text>
            {data.snapshot.diagnostics.nextActions.length > 0 ? (
              data.snapshot.diagnostics.nextActions.slice(0, 2).map((item) => (
                <Text key={`next-${item}`} as="p" variant="bodyMd">
                  Next: {item}
                </Text>
              ))
            ) : (
              <Text as="p" variant="bodyMd">
                Next: no immediate operator follow-up is required.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Contract
            </Text>
            <Text as="p" variant="bodyMd">
              Storefront alias: {data.routes.storefrontAlias}
            </Text>
            <Text as="p" variant="bodyMd">
              Backend path: {data.routes.proxyRequest}
            </Text>
            <Text as="p" variant="bodyMd">
              Provider default: {data.snapshot.provider}
            </Text>
            <Text as="p" variant="bodyMd">
              Template variables: {data.variables.join(", ")}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Persistence
            </Text>
            <Text as="p" variant="bodyMd">
              Templates: {data.snapshot.persistence.templateCount} total /{" "}
              {data.snapshot.persistence.activeTemplateCount} active /{" "}
              {data.snapshot.persistence.attachmentCount} attachments
            </Text>
            <Text as="p" variant="bodyMd">
              Logs: {data.snapshot.persistence.sendRequestCount} total /{" "}
              {data.snapshot.persistence.pendingCount} pending /{" "}
              {data.snapshot.persistence.sentCount} sent / {data.snapshot.persistence.failedCount}{" "}
              failed / {data.snapshot.persistence.blockedCount} blocked
            </Text>
            <Text as="p" variant="bodyMd">
              Rate-limit counters: {data.snapshot.persistence.rateCounterCount}
            </Text>
            <Text as="p" variant="bodyMd">
              Last request created: {formatTimestamp(data.snapshot.activity.lastRequestCreatedAt)}
            </Text>
            {data.snapshot.missing.length > 0 ? (
              <Text as="p" variant="bodyMd">
                Missing env: {data.snapshot.missing.join(", ")}
              </Text>
            ) : (
              <Text as="p" variant="bodyMd">
                Required mailer env keys for the chosen provider are present.
              </Text>
            )}
            {data.snapshot.runtimeIssue ? (
              <Text as="p" variant="bodyMd">
                Runtime issue: {data.snapshot.runtimeIssue}
              </Text>
            ) : null}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Preview
            </Text>
            <Text as="p" variant="bodyMd">
              Recent templates:{" "}
              {data.preview.templates.length > 0
                ? data.preview.templates
                    .map((item) => `${item.slug} (${item.attachmentCount})`)
                    .join(", ")
                : "none yet"}
            </Text>
            <Text as="p" variant="bodyMd">
              Recent logs:{" "}
              {data.preview.logs.length > 0
                ? data.preview.logs
                    .map((item) => `${item.status} ${item.recipientEmail}`)
                    .join(", ")
                : "none yet"}
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
