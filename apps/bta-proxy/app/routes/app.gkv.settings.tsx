import { requireGkvAdmin } from "~/domains/guide-viewer/adminRequest.server.ts";
import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { useLoaderData } from "react-router";
import { Badge, BlockStack, Box, Card, InlineStack, Page, Text } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { callGkvAdminApi } from "~/domains/guide-viewer/adminApi.server.ts";

type LoaderData = {
  status: {
    db: { ok: boolean };
    s3: { ok: boolean; bucket: string | null; region: string | null };
    kakao: { ok: boolean; key: string | null };
    healthLinks: { admin: string; v1: string };
  } | null;
  error?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireGkvAdmin(request);
  try {
    const status = await callGkvAdminApi<LoaderData["status"]>(request, "/admin/settings/status");
    return json<LoaderData>({ status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "설정 정보를 불러오지 못했습니다.";
    return json<LoaderData>({ status: null, error: message });
  }
};

function StatusBadge({ ok }: { ok: boolean }) {
  return ok ? <Badge tone="success">OK</Badge> : <Badge tone="critical">NOT OK</Badge>;
}

export default function GkvSettingsPage() {
  const { status, error } = useLoaderData<LoaderData>();

  return (
    <Page>
      <TitleBar title="GKV Settings" />
      <BlockStack gap="400">
        <Text as="h1" variant="headingLg">
          Settings
        </Text>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Connectivity
            </Text>

            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd">
                DB
              </Text>
              <StatusBadge ok={Boolean(status?.db.ok)} />
            </InlineStack>

            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd">
                S3
              </Text>
              <StatusBadge ok={Boolean(status?.s3.ok)} />
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Bucket: {status?.s3.bucket ?? "-"} / Region: {status?.s3.region ?? "-"}
            </Text>

            <InlineStack align="space-between" blockAlign="center">
              <Text as="p" variant="bodyMd">
                Kakao API
              </Text>
              <StatusBadge ok={Boolean(status?.kakao.ok)} />
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Key: {status?.kakao.key ?? "-"}
            </Text>
          </BlockStack>
        </Card>

        {error ? (
          <Card>
            <Box padding="300">
              <Text as="p" variant="bodyMd" tone="critical">
                {error}
              </Text>
            </Box>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
