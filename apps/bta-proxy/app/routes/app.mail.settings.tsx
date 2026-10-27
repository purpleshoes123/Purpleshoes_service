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
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import { MAILER_ROUTE_PATHS } from "~/lib/mailer/contracts";
import { getMailerEnvSummary } from "~/lib/mailer/env";
import {
  verifyConfiguredMailProviderConnection,
} from "~/lib/mailer/provider.server";
import { getMailerSettingsSnapshot } from "~/lib/mailer/settings.server";
import { withEmbeddedSearch } from "~/lib/gkv/embeddedPath";
import { authenticate } from "~/shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  return json({
    snapshot: await getMailerSettingsSnapshot({
      shopDomain: auth.session.shop,
      prisma: db,
    }),
  });
};

type ActionIntent = "verify_smtp_connection" | "unknown";

type ActionData =
  | {
      ok: true;
      intent: "verify_smtp_connection";
      successMessage: string;
      checkedAt: string;
      detail: string;
    }
  | {
      ok: false;
      intent: ActionIntent;
      errorMessage: string;
    };

function getVerifyErrorMessage(error: unknown) {
  const code = String((error as NodeJS.ErrnoException | undefined)?.code || "")
    .trim()
    .toUpperCase();

  if (error instanceof Error && error.name === "MailProviderTimeoutError") {
    return "SMTP 연결 검증이 시간 초과되었습니다. 호스트, 포트, secure 설정과 네트워크 접근을 확인하세요.";
  }

  if (code === "EAUTH") {
    return "SMTP 인증에 실패했습니다. SMTP_USERNAME과 앱 비밀번호를 다시 확인하세요.";
  }

  if (
    [
      "ECONNECTION",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ESOCKET",
    ].includes(code)
  ) {
    return "SMTP 서버 연결에 실패했습니다. SMTP_HOST, SMTP_PORT, SMTP_SECURE 조합과 방화벽 정책을 확인하세요.";
  }

  return error instanceof Error
    ? error.message
    : "SMTP 연결 검증 중 알 수 없는 오류가 발생했습니다.";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();

  if (intent !== "verify_smtp_connection") {
    return json<ActionData>({
      ok: false,
      intent: "unknown",
      errorMessage: "알 수 없는 요청입니다.",
    });
  }

  const envSummary = getMailerEnvSummary();
  if (envSummary.provider !== "SMTP") {
    return json<ActionData>({
      ok: false,
      intent,
      errorMessage:
        "현재 연결 검증은 MAIL_PROVIDER=SMTP 일 때만 실행할 수 있습니다.",
    });
  }

  if (!envSummary.envConfigured) {
    return json<ActionData>({
      ok: false,
      intent,
      errorMessage: `필수 메일러 env가 누락되어 연결 검증을 실행할 수 없습니다: ${envSummary.missing.join(", ")}`,
    });
  }

  if (!envSummary.runtimeReady) {
    return json<ActionData>({
      ok: false,
      intent,
      errorMessage: `현재 runtime에서는 SMTP 연결 검증을 실행할 수 없습니다: ${envSummary.runtimeIssue}`,
    });
  }

  try {
    const result = await verifyConfiguredMailProviderConnection();

    return json<ActionData>({
      ok: true,
      intent,
      successMessage: "SMTP 연결 검증에 성공했습니다.",
      checkedAt: result.checkedAt,
      detail: result.detail,
    });
  } catch (error) {
    return json<ActionData>({
      ok: false,
      intent,
      errorMessage: getVerifyErrorMessage(error),
    });
  }
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

export default function MailSettingsPage() {
  const { snapshot } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const navigation = useNavigation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const statusLabel = formatStatusLabel(snapshot.diagnostics.status);
  const statusTone = formatStatusTone(snapshot.diagnostics.status);
  const verifyFormAction = toInApp(MAILER_ROUTE_PATHS.adminSettings);
  const isVerifying =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "verify_smtp_connection";
  const canVerifySmtp =
    snapshot.provider === "SMTP" &&
    snapshot.envConfigured &&
    snapshot.runtimeReady;

  return (
    <Page>
      <TitleBar title="Mail Settings" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            Mail Settings
          </Text>
          <Button url={toInApp(MAILER_ROUTE_PATHS.adminRoot)}>Overview</Button>
        </InlineStack>

        {actionData ? (
          actionData.ok ? (
            <Banner tone="success">
              <p>
                {actionData.successMessage} {actionData.checkedAt.replace(".000Z", "Z").replace("T", " ")} /{" "}
                {actionData.detail}
              </p>
            </Banner>
          ) : (
            <Banner tone="critical">
              <p>{actionData.errorMessage}</p>
            </Banner>
          )
        ) : null}

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Provider
              </Text>
              <Badge tone={statusTone}>
                {snapshot.provider} / {statusLabel}
              </Badge>
            </InlineStack>
            <Text as="p" variant="bodyMd">
              {snapshot.diagnostics.summary}
            </Text>
            <Text as="p" variant="bodyMd">
              Shop: {snapshot.shopDomain}
            </Text>
            <Text as="p" variant="bodyMd">
              Env configured: {snapshot.envConfigured ? "yes" : "no"} / runtime ready:{" "}
              {snapshot.runtimeReady ? "yes" : "no"}
            </Text>
            <Text as="p" variant="bodyMd">
              reCAPTCHA action: {snapshot.recaptcha.action} / threshold:{" "}
              {String(snapshot.recaptcha.threshold)}
            </Text>
            {snapshot.provider === "AWS_SES" ? (
              <>
                <Text as="p" variant="bodyMd">
                  SES region: {snapshot.providerSettings.sesRegion || "unset"}
                </Text>
                <Text as="p" variant="bodyMd">
                  SES configuration set:{" "}
                  {snapshot.providerSettings.sesConfigurationSetConfigured
                    ? "configured"
                    : "unset"}
                </Text>
                <Text as="p" variant="bodyMd">
                  SES source ARN:{" "}
                  {snapshot.providerSettings.sesSourceArnConfigured
                    ? "configured"
                    : "unset"}
                </Text>
              </>
            ) : null}
            {snapshot.provider === "SMTP" ? (
              <>
                <Text as="p" variant="bodyMd">
                  SMTP host: {snapshot.providerSettings.smtpHost || "unset"}
                </Text>
                <Text as="p" variant="bodyMd">
                  SMTP port:{" "}
                  {snapshot.providerSettings.smtpPort != null
                    ? String(snapshot.providerSettings.smtpPort)
                    : "unset"}
                  {` `}/ secure:{" "}
                  {snapshot.providerSettings.smtpSecure == null
                    ? "unset"
                    : snapshot.providerSettings.smtpSecure
                      ? "true"
                      : "false"}
                </Text>
                <Text as="p" variant="bodyMd">
                  SMTP username:{" "}
                  {snapshot.providerSettings.smtpUsernameConfigured
                    ? "configured"
                    : "unset"}
                  {` `}/ password:{" "}
                  {snapshot.providerSettings.smtpPasswordConfigured
                    ? "configured"
                    : "unset"}
                </Text>
              </>
            ) : null}
            {snapshot.provider === "SENDGRID" || snapshot.provider === "RESEND" ? (
              <Text as="p" variant="bodyMd">
                Provider API key:{" "}
                {snapshot.providerSettings.apiKeyConfigured
                  ? "configured"
                  : "unset"}
              </Text>
            ) : null}
            <Text as="p" variant="bodyMd">
              Attachment policy: {snapshot.attachmentPolicy.maxTemplateAttachmentCount} files,
              {` `}
              {snapshot.attachmentPolicy.maxAttachmentBytes} bytes per file,
              {` `}
              {snapshot.attachmentPolicy.maxTotalAttachmentBytes} bytes total
            </Text>
            <Text as="p" variant="bodyMd">
              Rate limits: email {snapshot.rateLimits.emailPer10Min}/10min, IP{" "}
              {snapshot.rateLimits.ipPer10Min}/10min, template{" "}
              {snapshot.rateLimits.templatePerHour}/hour
            </Text>
            <Text as="p" variant="bodyMd">
              Log retention: {snapshot.retention.logRetentionDays} days
            </Text>
            <Text as="p" variant="bodyMd">
              Storage: preferred {snapshot.storage.preferredType}, supported{" "}
              {snapshot.storage.supportedTypes.join(", ")}
            </Text>
            {snapshot.missing.length > 0 ? (
              <Text as="p" variant="bodyMd" tone="critical">
                Missing env: {snapshot.missing.join(", ")}
              </Text>
            ) : null}
            {snapshot.runtimeIssue ? (
              <Text as="p" variant="bodyMd" tone="critical">
                Runtime issue: {snapshot.runtimeIssue}
              </Text>
            ) : null}
          </BlockStack>
        </Card>

        {snapshot.provider === "SMTP" ? (
          <Card>
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  SMTP Connection Check
                </Text>
                <Badge tone={canVerifySmtp ? "success" : "attention"}>
                  {canVerifySmtp ? "Ready to Run" : "Blocked"}
                </Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd">
                This check opens an authenticated SMTP session without sending a real mail.
              </Text>
              <Text as="p" variant="bodyMd">
                Use it to validate Gmail app-password credentials before the first admin test send.
              </Text>
              <Form method="post" action={verifyFormAction}>
                <input type="hidden" name="intent" value="verify_smtp_connection" />
                <Button
                  submit
                  variant="primary"
                  loading={isVerifying}
                  disabled={!canVerifySmtp}
                >
                  Verify SMTP Connection
                </Button>
              </Form>
              {!canVerifySmtp ? (
                <Text as="p" variant="bodyMd" tone="critical">
                  SMTP 연결 검증은 `MAIL_PROVIDER=SMTP` 이고 필수 env가 모두 준비된 상태에서만 실행할 수 있습니다.
                </Text>
              ) : null}
            </BlockStack>
          </Card>
        ) : null}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Operational Guidance
            </Text>
            {snapshot.diagnostics.nextActions.length > 0 ? (
              snapshot.diagnostics.nextActions.map((item) => (
                <Text key={`next-${item}`} as="p" variant="bodyMd">
                  Next: {item}
                </Text>
              ))
            ) : (
              <Text as="p" variant="bodyMd">
                Next: No immediate operator follow-up is required.
              </Text>
            )}
            {snapshot.diagnostics.warnings.length > 0 ? (
              snapshot.diagnostics.warnings.map((item) => (
                <Text key={`warn-${item}`} as="p" variant="bodyMd" tone="critical">
                  Warning: {item}
                </Text>
              ))
            ) : (
              <Text as="p" variant="bodyMd" tone="success">
                Warnings: none
              </Text>
            )}
            {snapshot.diagnostics.providerNotes.map((item) => (
              <Text key={`provider-${item}`} as="p" variant="bodyMd">
                Provider note: {item}
              </Text>
            ))}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Recent Activity
            </Text>
            <Text as="p" variant="bodyMd">
              Last {snapshot.activity.recentWindowHours}h: requests{" "}
              {snapshot.activity.recentRequestCount} / pending{" "}
              {snapshot.activity.recentPendingCount} / sent{" "}
              {snapshot.activity.recentSentCount} / failed{" "}
              {snapshot.activity.recentFailedCount} / blocked{" "}
              {snapshot.activity.recentBlockedCount}
            </Text>
            <Text as="p" variant="bodyMd">
              Last template update: {formatTimestamp(snapshot.activity.lastTemplateUpdatedAt)}
            </Text>
            <Text as="p" variant="bodyMd">
              Last request created: {formatTimestamp(snapshot.activity.lastRequestCreatedAt)}
            </Text>
            <Text as="p" variant="bodyMd">
              Last sent: {formatTimestamp(snapshot.activity.lastSentAt)}
            </Text>
            <Text as="p" variant="bodyMd">
              Last failed: {formatTimestamp(snapshot.activity.lastFailedAt)}
              {snapshot.activity.latestFailureCode
                ? ` / code ${snapshot.activity.latestFailureCode}`
                : ""}
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Persistence Snapshot
            </Text>
            <Text as="p" variant="bodyMd">
              Templates {snapshot.persistence.templateCount} / attachments{" "}
              {snapshot.persistence.attachmentCount}
            </Text>
            <Text as="p" variant="bodyMd">
              Logs {snapshot.persistence.sendRequestCount} / pending{" "}
              {snapshot.persistence.pendingCount} / sent{" "}
              {snapshot.persistence.sentCount} / failed{" "}
              {snapshot.persistence.failedCount} / blocked{" "}
              {snapshot.persistence.blockedCount}
            </Text>
            <Text as="p" variant="bodyMd">
              Rate-limit windows tracked: {snapshot.persistence.rateCounterCount}
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
