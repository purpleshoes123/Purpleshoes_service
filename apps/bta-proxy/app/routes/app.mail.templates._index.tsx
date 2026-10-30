import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useLoaderData, useLocation } from "react-router";
import { BlockStack, Button, Card, DataTable, InlineStack, Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import {
  MAILER_ATTACHMENT_MODE_VALUES,
  MAILER_ROUTE_PATHS,
  MAILER_TEMPLATE_VARIABLES,
} from "~/domains/mail/contracts";
import { withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";
import { listTemplateSummaries } from "~/domains/mail/templateStore.server.ts";
import { authenticate } from "~/shopify.server";

const SAMPLE_TEMPLATE_ID = "guide-request";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const templates = await listTemplateSummaries(db, {
    shopDomain: auth.session.shop,
    limit: 20,
  });

  return json({
    shopDomain: auth.session.shop,
    templates: templates.items.map((item) => ({
      id: item.id,
      name: item.name,
      slug: item.slug,
      isActive: item.isActive,
      attachmentCount: item.attachmentCount,
      updatedAt: item.updatedAt.toISOString(),
    })),
  });
};

export default function MailTemplatesIndexPage() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const sampleId = data.templates[0]?.id || SAMPLE_TEMPLATE_ID;

  return (
    <Page>
      <TitleBar title="Mail Templates" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            Mail Templates
          </Text>
          <InlineStack gap="200">
            <Button url={toInApp(MAILER_ROUTE_PATHS.adminRoot)}>Overview</Button>
            <Button variant="primary" url={toInApp(MAILER_ROUTE_PATHS.adminTemplateNew)}>
              New Template
            </Button>
          </InlineStack>
        </InlineStack>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Frozen inputs
            </Text>
            <Text as="p" variant="bodyMd">
              Shop scope: {data.shopDomain}
            </Text>
            <Text as="p" variant="bodyMd">
              Attachment modes: {MAILER_ATTACHMENT_MODE_VALUES.join(", ")}
            </Text>
            <Text as="p" variant="bodyMd">
              Template variables: {MAILER_TEMPLATE_VARIABLES.join(", ")}
            </Text>
            <InlineStack gap="200">
              <Button url={toInApp(MAILER_ROUTE_PATHS.adminTemplateDetail(sampleId))}>
                Open Detail Route
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Persisted Templates
            </Text>
            {data.templates.length > 0 ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "numeric", "text"]}
                headings={["Name", "Slug", "Active", "Attachments", "Updated"]}
                rows={data.templates.map((item) => [
                  <Button
                    key={`${item.id}-open`}
                    variant="plain"
                    url={toInApp(MAILER_ROUTE_PATHS.adminTemplateDetail(item.id))}
                  >
                    {item.name}
                  </Button>,
                  item.slug,
                  item.isActive ? "Yes" : "No",
                  String(item.attachmentCount),
                  item.updatedAt,
                ])}
              />
            ) : (
              <Text as="p" variant="bodyMd">
                No templates are stored yet.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
