import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Form, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import {
  Banner,
  Badge,
  BlockStack,
  Button,
  Card,
  InlineStack,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import { MAILER_ROUTE_PATHS } from "~/lib/mailer/contracts";
import {
  getSendRequestDetail,
} from "~/lib/mailer/sendRequestStore.server";
import { resendFailedMailRequest } from "~/lib/mailer/service.server";
import { getTemplateById } from "~/lib/mailer/templateStore.server";
import { withEmbeddedSearch } from "~/lib/gkv/embeddedPath";
import { authenticate } from "~/shopify.server";

type ActionData =
  | {
      ok: true;
      successMessage: string;
      requestId: string;
      sentAt: string;
    }
  | {
      ok: false;
      errorMessage: string;
    };

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const logId = params.logId || "";
  const detail = await getSendRequestDetail(db, logId);

  if (!detail || detail.shopDomain !== auth.session.shop) {
    throw new Response("Not Found", { status: 404 });
  }

  const template = await getTemplateById(db, detail.templateId, {
    includeDeleted: true,
  });

  return json({
    log: {
      id: detail.id,
      status: detail.status,
      requestSource: detail.requestSource,
      recipientEmail: detail.recipientEmail,
      maskedRecipientEmail: detail.maskedRecipientEmail,
      recipientName: detail.recipientName || "",
      pagePath: detail.pagePath || "",
      createdAt: detail.createdAt.toISOString(),
      sentAt: detail.sentAt?.toISOString() || null,
      recaptchaAction: detail.recaptchaAction || "",
      recaptchaScore:
        detail.recaptchaScore === null ? null : String(detail.recaptchaScore),
      recaptchaSuccess:
        detail.recaptchaSuccess === null ? null : String(detail.recaptchaSuccess),
      failureCode: detail.failureCode || "",
      failureReason: detail.failureReason || "",
      emailProvider: detail.emailProvider,
      providerMessageId: detail.providerMessageId || "",
      templateNameSnapshot: detail.templateNameSnapshot || "",
      templateSlugSnapshot: detail.templateSlugSnapshot || "",
      attachmentModeSnapshot: detail.attachmentModeSnapshot || "",
      subjectSnapshot: detail.subjectSnapshot || "",
      htmlBodySnapshot: detail.htmlBodySnapshot || "",
      textBodySnapshot: detail.textBodySnapshot || "",
      fromNameSnapshot: detail.fromNameSnapshot || "",
      replyToSnapshot: detail.replyToSnapshot || "",
      hasHistoricalSnapshot: Boolean(
        detail.subjectSnapshot &&
          detail.htmlBodySnapshot &&
          detail.attachmentModeSnapshot
      ),
      attachments: detail.attachments.map((item) => ({
        id: item.id,
        fileName: item.resolvedFileName,
        mimeType: item.resolvedMimeType,
        sizeBytes: item.resolvedFileSizeBytes,
        fileUrl: item.resolvedFileUrl,
      })),
    },
    template: template && template.shopDomain === auth.session.shop
      ? {
          id: template.id,
          name: template.name,
          slug: template.slug,
          isActive: template.isActive,
          deletedAt: template.deletedAt?.toISOString() || null,
        }
      : null,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const logId = params.logId || "";
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();

  if (intent !== "resend") {
    return json<ActionData>({
      ok: false,
      errorMessage: "지원하지 않는 작업입니다.",
    });
  }

  try {
    const result = await resendFailedMailRequest({
      shopDomain: auth.session.shop,
      sendRequestId: logId,
      prisma: db,
    });

    return json<ActionData>({
      ok: true,
      successMessage: "재발송을 완료했습니다.",
      requestId: result.requestId,
      sentAt: result.sentAt,
    });
  } catch (error) {
    return json<ActionData>({
      ok: false,
      errorMessage:
        error instanceof Error ? error.message : "재발송 중 오류가 발생했습니다.",
    });
  }
};

export default function MailLogDetailPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const isSubmitting = navigation.state !== "idle";
  const resendAllowed = data.log.status === "FAILED";

  return (
    <Page>
      <TitleBar title="Mail Log Detail" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Button url={toInApp(MAILER_ROUTE_PATHS.adminLogs)}>Back to Logs</Button>
          <Badge
            tone={
              data.log.status === "SENT"
                ? "success"
                : data.log.status === "BLOCKED"
                  ? "attention"
                  : data.log.status === "FAILED"
                    ? "critical"
                    : "info"
            }
          >
            {data.log.status}
          </Badge>
        </InlineStack>

        {actionData ? (
          actionData.ok ? (
            <Banner tone="success" title="Resent">
              <p>
                {actionData.successMessage} New request ID: {actionData.requestId} / sentAt:{" "}
                {actionData.sentAt}
              </p>
            </Banner>
          ) : (
            <Banner tone="critical" title="Resend failed">
              <p>{actionData.errorMessage}</p>
            </Banner>
          )
        ) : null}

        <Card>
          <BlockStack gap="300">
            <Text as="h1" variant="headingLg">
              Log: {data.log.id}
            </Text>
            <Text as="p" variant="bodyMd">
              Recipient: {data.log.recipientEmail}
            </Text>
            <Text as="p" variant="bodyMd">
              Source: {data.log.requestSource}
            </Text>
            <Text as="p" variant="bodyMd">
              Provider: {data.log.emailProvider}
            </Text>
            <Text as="p" variant="bodyMd">
              Provider message ID: {data.log.providerMessageId || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              Created: {data.log.createdAt}
            </Text>
            <Text as="p" variant="bodyMd">
              Sent: {data.log.sentAt || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              Page path: {data.log.pagePath || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              reCAPTCHA: action {data.log.recaptchaAction || "-"} / score{" "}
              {data.log.recaptchaScore || "-"} / success{" "}
              {data.log.recaptchaSuccess || "-"}
            </Text>
            <Text as="p" variant="bodyMd">
              Failure: {data.log.failureCode || "-"} / {data.log.failureReason || "-"}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Historical Snapshot
            </Text>
            {data.log.hasHistoricalSnapshot ? (
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd">
                  Template snapshot: {data.log.templateNameSnapshot || "-"} (
                  {data.log.templateSlugSnapshot || "-"})
                </Text>
                <Text as="p" variant="bodyMd">
                  Attachment mode: {data.log.attachmentModeSnapshot || "-"}
                </Text>
                <Text as="p" variant="bodyMd">
                  From name: {data.log.fromNameSnapshot || "-"} / Reply-to:{" "}
                  {data.log.replyToSnapshot || "-"}
                </Text>
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  Subject: {data.log.subjectSnapshot}
                </Text>
                <iframe
                  title="mail-log-html-snapshot"
                  sandbox=""
                  srcDoc={data.log.htmlBodySnapshot}
                  style={{
                    width: "100%",
                    minHeight: "320px",
                    border: "1px solid var(--p-color-border-secondary)",
                    borderRadius: "12px",
                    background: "var(--p-color-bg-surface-secondary)",
                  }}
                />
                <Text as="h3" variant="headingSm">
                  Plain Text Snapshot
                </Text>
                <pre
                  style={{
                    margin: 0,
                    padding: "16px",
                    whiteSpace: "pre-wrap",
                    borderRadius: "12px",
                    background: "var(--p-color-bg-surface-secondary)",
                    border: "1px solid var(--p-color-border-secondary)",
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  }}
                >
                  {data.log.textBodySnapshot}
                </pre>
              </BlockStack>
            ) : (
              <Text as="p" variant="bodyMd">
                이 로그는 historical snapshot이 없어 현재 템플릿 참조만 가능합니다.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Current Template Reference
            </Text>
            {data.template ? (
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd">
                  {data.template.name} ({data.template.slug})
                </Text>
                <Text as="p" variant="bodyMd">
                  Active: {data.template.isActive ? "Yes" : "No"} / deletedAt:{" "}
                  {data.template.deletedAt || "-"}
                </Text>
                <Button
                  url={toInApp(MAILER_ROUTE_PATHS.adminTemplateDetail(data.template.id))}
                >
                  Open Template
                </Button>
              </BlockStack>
            ) : (
              <Text as="p" variant="bodyMd">
                현재 참조 가능한 템플릿이 없습니다.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Attachments
            </Text>
            {data.log.attachments.length > 0 ? (
              <List type="bullet">
                {data.log.attachments.map((item) => (
                  <List.Item key={item.id}>
                    {item.fileName} ({item.mimeType}, {item.sizeBytes} bytes)
                  </List.Item>
                ))}
              </List>
            ) : (
              <Text as="p" variant="bodyMd">
                첨부 기록이 없습니다.
              </Text>
            )}
          </BlockStack>
        </Card>

        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="resend" />
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Resend
              </Text>
              <Text as="p" variant="bodyMd">
                현재 구현은 `FAILED` 로그만 재발송할 수 있습니다. historical
                snapshot이 있으면 해당 subject/body/attachment snapshot을 우선
                사용하고, legacy 로그는 현재 템플릿 기준으로 fallback 합니다.
              </Text>
              <Button submit disabled={!resendAllowed} loading={isSubmitting}>
                Resend Failed Mail
              </Button>
            </BlockStack>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
