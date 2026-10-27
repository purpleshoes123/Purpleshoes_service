import type { LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Form, useLoaderData, useLocation } from "react-router";
import { useEffect, useState } from "react";
import {
  Badge,
  BlockStack,
  Button,
  Card,
  DataTable,
  FormLayout,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import {
  MAILER_ROUTE_PATHS,
  MAILER_SEND_STATUS_VALUES,
  type MailSendStatus,
} from "~/lib/mailer/contracts";
import {
  getEmbeddedSearchEntries,
  withEmbeddedSearch,
} from "~/lib/gkv/embeddedPath";
import { listSendRequests } from "~/lib/mailer/sendRequestStore.server";
import { authenticate } from "~/shopify.server";

const SAMPLE_LOG_ID = "sample-log";
const LOG_LIMIT = 50;

const SEND_STATUS_LABELS: Record<MailSendStatus, string> = {
  PENDING: "대기",
  SENT: "발송 완료",
  FAILED: "실패",
  BLOCKED: "차단",
};

function isSendStatus(value: string): value is MailSendStatus {
  return (MAILER_SEND_STATUS_VALUES as readonly string[]).includes(value);
}

function getStatusTone(status: MailSendStatus) {
  if (status === "SENT") return "success" as const;
  if (status === "FAILED") return "critical" as const;
  if (status === "BLOCKED") return "warning" as const;
  return "attention" as const;
}

function formatTemplateLabel(template: {
  name: string;
  slug: string;
  deletedAt: string | null;
}) {
  return `${template.name} (${template.slug})${template.deletedAt ? " - 삭제됨" : ""}`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const url = new URL(request.url);
  const templateId = (url.searchParams.get("templateId") || "").trim();
  const statusParam = (url.searchParams.get("status") || "")
    .trim()
    .toUpperCase();
  const status = isSendStatus(statusParam) ? statusParam : "";
  const recipientEmail = (url.searchParams.get("recipientEmail") || "").trim();

  const templates = await db.mailTemplate.findMany({
    where: {
      shopDomain: auth.session.shop,
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      deletedAt: true,
    },
  });
  const templateById = new Map(templates.map((template) => [template.id, template]));

  const logs = await listSendRequests(db, {
    shopDomain: auth.session.shop,
    templateId: templateId || undefined,
    status: status || undefined,
    recipientEmailQuery: recipientEmail || undefined,
    limit: LOG_LIMIT,
  });

  return json({
    shopDomain: auth.session.shop,
    filters: {
      templateId,
      status,
      recipientEmail,
    },
    templates: templates.map((template) => ({
      id: template.id,
      name: template.name,
      slug: template.slug,
      deletedAt: template.deletedAt?.toISOString() || null,
    })),
    logs: logs.items.map((item) => ({
      id: item.id,
      status: item.status,
      templateId: item.templateId,
      template: templateById.has(item.templateId)
        ? {
            id: item.templateId,
            name: templateById.get(item.templateId)?.name || "",
            slug: templateById.get(item.templateId)?.slug || "",
            deletedAt:
              templateById.get(item.templateId)?.deletedAt?.toISOString() || null,
          }
        : null,
      recipientEmail: item.maskedRecipientEmail,
      recaptchaScore:
        item.recaptchaScore === null ? "-" : String(item.recaptchaScore),
      pagePath: item.pagePath || "-",
      createdAt: item.createdAt.toISOString(),
    })),
  });
};

export default function MailLogsIndexPage() {
  const data = useLoaderData<typeof loader>();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const sampleId = data.logs[0]?.id || SAMPLE_LOG_ID;
  const embeddedEntries = getEmbeddedSearchEntries(location.search);
  const embeddedSearch = new URLSearchParams(
    embeddedEntries.map((entry) => [entry.name, entry.value])
  ).toString();
  const toEmbeddedOnly = (path: string) =>
    withEmbeddedSearch(path, embeddedSearch ? `?${embeddedSearch}` : "");
  const [templateId, setTemplateId] = useState(data.filters.templateId);
  const [status, setStatus] = useState(data.filters.status);
  const [recipientEmail, setRecipientEmail] = useState(
    data.filters.recipientEmail
  );

  useEffect(() => {
    setTemplateId(data.filters.templateId);
    setStatus(data.filters.status);
    setRecipientEmail(data.filters.recipientEmail);
  }, [data.filters.recipientEmail, data.filters.status, data.filters.templateId]);

  const templateOptions = [
    { label: "전체 템플릿", value: "" },
    ...data.templates.map((template) => ({
      label: formatTemplateLabel(template),
      value: template.id,
    })),
  ];
  const statusOptions = [
    { label: "전체 상태", value: "" },
    ...MAILER_SEND_STATUS_VALUES.map((value) => ({
      label: SEND_STATUS_LABELS[value],
      value,
    })),
  ];
  const activeFilters = [
    data.filters.templateId ? "템플릿" : "",
    data.filters.status ? "상태" : "",
    data.filters.recipientEmail ? "수신 이메일" : "",
  ].filter(Boolean);

  return (
    <Page>
      <TitleBar title="메일 발송 로그" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            메일 발송 로그
          </Text>
          <Button url={toEmbeddedOnly(MAILER_ROUTE_PATHS.adminRoot)}>
            메일 개요
          </Button>
        </InlineStack>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              로그 필터
            </Text>
            <Form method="get" action={MAILER_ROUTE_PATHS.adminLogs}>
              {embeddedEntries.map((entry) => (
                <input
                  key={entry.name}
                  type="hidden"
                  name={entry.name}
                  value={entry.value}
                />
              ))}
              <FormLayout>
                <FormLayout.Group>
                  <Select
                    label="템플릿"
                    name="templateId"
                    options={templateOptions}
                    value={templateId}
                    onChange={setTemplateId}
                  />
                  <Select
                    label="상태"
                    name="status"
                    options={statusOptions}
                    value={status}
                    onChange={setStatus}
                  />
                  <TextField
                    label="수신 이메일 검색"
                    name="recipientEmail"
                    value={recipientEmail}
                    onChange={setRecipientEmail}
                    autoComplete="email"
                    placeholder="email@example.com"
                  />
                </FormLayout.Group>
                <InlineStack gap="200">
                  <Button submit variant="primary">
                    적용
                  </Button>
                  <Button url={toEmbeddedOnly(MAILER_ROUTE_PATHS.adminLogs)}>
                    초기화
                  </Button>
                </InlineStack>
              </FormLayout>
            </Form>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                발송 내역
              </Text>
              <Text as="span" variant="bodySm">
                {activeFilters.length > 0
                  ? `적용된 필터: ${activeFilters.join(", ")}`
                  : "필터 없음"}{" "}
                / 상점: {data.shopDomain}
              </Text>
            </InlineStack>
            {data.logs.length > 0 ? (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                ]}
                headings={[
                  "상태",
                  "템플릿",
                  "수신자",
                  "점수",
                  "페이지",
                  "생성일",
                ]}
                rows={data.logs.map((item) => [
                  <Button
                    key={`${item.id}-open`}
                    variant="plain"
                    url={toInApp(MAILER_ROUTE_PATHS.adminLogDetail(item.id))}
                  >
                    <Badge tone={getStatusTone(item.status)}>
                      {SEND_STATUS_LABELS[item.status]}
                    </Badge>
                  </Button>,
                  item.template ? (
                    <Button
                      key={`${item.id}-template`}
                      variant="plain"
                      url={toInApp(
                        MAILER_ROUTE_PATHS.adminTemplateDetail(item.template.id)
                      )}
                    >
                      {formatTemplateLabel(item.template)}
                    </Button>
                  ) : (
                    `알 수 없는 템플릿 (${item.templateId})`
                  ),
                  item.recipientEmail,
                  item.recaptchaScore,
                  item.pagePath,
                  item.createdAt,
                ])}
              />
            ) : (
              <Text as="p" variant="bodyMd">
                조건에 맞는 발송 로그가 없습니다.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
