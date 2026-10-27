import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { redirect } from "react-router";
import { Form, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import { useState } from "react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  FormLayout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import {
  parseMailTemplateEditorForm,
  type MailTemplateEditorInput,
} from "~/lib/mailer/adminForms.server";
import {
  MAILER_ATTACHMENT_MODE_VALUES,
  MAILER_ROUTE_PATHS,
  MAILER_TEMPLATE_VARIABLES,
} from "~/lib/mailer/contracts";
import { renderMailTemplate } from "~/lib/mailer/render";
import {
  createTemplate,
  isTemplateSlugTaken,
} from "~/lib/mailer/templateStore.server";
import { withEmbeddedSearch } from "~/lib/gkv/embeddedPath";
import { authenticate } from "~/shopify.server";

type ActionData = {
  ok: false;
  errorMessage: string;
  fieldErrors?: Partial<Record<keyof MailTemplateEditorInput, string>>;
};

function extractFieldErrors(error: unknown) {
  if (!error || typeof error !== "object" || !("issues" in error)) {
    return {};
  }

  const issues = (error as { issues: Array<{ path?: Array<string | number>; message: string }> }).issues;
  const fieldErrors: Record<string, string> = {};

  for (const issue of issues) {
    const field = String(issue.path?.[0] || "");
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return fieldErrors;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  return json({
    shopDomain: auth.session.shop,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const formData = await request.formData();

  try {
    const input = parseMailTemplateEditorForm(formData);
    const slugTaken = await isTemplateSlugTaken(db, {
      shopDomain: auth.session.shop,
      slug: input.slug,
    });

    if (slugTaken) {
      return json<ActionData>({
        ok: false,
        errorMessage: "이미 사용 중인 템플릿 슬러그입니다.",
        fieldErrors: {
          slug: "이미 사용 중인 템플릿 슬러그입니다.",
        },
      });
    }

    const created = await createTemplate(db, {
      shopDomain: auth.session.shop,
      ...input,
    });

    const search = new URL(request.url).search;
    throw redirect(
      withEmbeddedSearch(
        MAILER_ROUTE_PATHS.adminTemplateDetail(created.id),
        search
      )
    );
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    return json<ActionData>({
      ok: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "템플릿 생성 중 오류가 발생했습니다.",
      fieldErrors: extractFieldErrors(error),
    });
  }
};

export default function MailTemplateNewPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const isSubmitting = navigation.state !== "idle";

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [subject, setSubject] = useState("");
  const [htmlBody, setHtmlBody] = useState("");
  const [textBody, setTextBody] = useState("");
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [attachmentMode, setAttachmentMode] = useState("NONE");
  const [isActive, setIsActive] = useState(true);
  const preview = renderMailTemplate({
    subject,
    htmlBody,
    textBody,
    variables: {
      shopName: data.shopDomain,
      recipientEmail: "preview@example.com",
      pagePath: "/pages/request-guide",
      sentAt: "2026-04-14T09:00:00+09:00",
    },
  });

  const fieldErrors = actionData?.fieldErrors || {};

  return (
    <Page>
      <TitleBar title="New Mail Template" />
      <BlockStack gap="400">
        <Button url={toInApp(MAILER_ROUTE_PATHS.adminTemplates)}>
          Back to Templates
        </Button>

        {actionData && !actionData.ok ? (
          <Banner tone="critical" title="Create failed">
            <p>{actionData.errorMessage}</p>
          </Banner>
        ) : null}

        <Card>
          <Form method="post">
            <BlockStack gap="400">
              <Text as="h1" variant="headingLg">
                New Template
              </Text>

              <FormLayout>
                <TextField
                  label="Template name"
                  name="name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  error={fieldErrors.name}
                />
                <TextField
                  label="Slug"
                  name="slug"
                  value={slug}
                  onChange={setSlug}
                  autoComplete="off"
                  helpText="Lowercase letters, numbers, hyphen only."
                  error={fieldErrors.slug}
                />
                <TextField
                  label="Subject"
                  name="subject"
                  value={subject}
                  onChange={setSubject}
                  autoComplete="off"
                  error={fieldErrors.subject}
                />
                <TextField
                  label="HTML body"
                  name="htmlBody"
                  value={htmlBody}
                  onChange={setHtmlBody}
                  autoComplete="off"
                  multiline={10}
                  error={fieldErrors.htmlBody}
                />
                <TextField
                  label="TEXT body"
                  name="textBody"
                  value={textBody}
                  onChange={setTextBody}
                  autoComplete="off"
                  multiline={6}
                  helpText="비워두면 HTML 본문에서 plain text fallback을 생성합니다."
                  error={fieldErrors.textBody}
                />
                <TextField
                  label="From name override"
                  name="fromName"
                  value={fromName}
                  onChange={setFromName}
                  autoComplete="off"
                  error={fieldErrors.fromName}
                />
                <TextField
                  label="Reply-to override"
                  name="replyTo"
                  type="email"
                  value={replyTo}
                  onChange={setReplyTo}
                  autoComplete="email"
                  error={fieldErrors.replyTo}
                />
                <Select
                  label="Attachment mode"
                  name="attachmentMode"
                  options={MAILER_ATTACHMENT_MODE_VALUES.map((value) => ({
                    label: value,
                    value,
                  }))}
                  value={attachmentMode}
                  onChange={setAttachmentMode}
                />
                <Checkbox
                  label="Template active"
                  checked={isActive}
                  onChange={setIsActive}
                  name="isActive"
                  value="true"
                />
              </FormLayout>

              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Supported variables
                </Text>
                <Text as="p" variant="bodyMd">
                  {MAILER_TEMPLATE_VARIABLES.join(", ")}
                </Text>
              </BlockStack>

              <Button submit variant="primary" loading={isSubmitting}>
                Create Template
              </Button>
            </BlockStack>
          </Form>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              HTML Preview
            </Text>
            <Text as="p" variant="bodyMd">
              sample variables: shop=`{data.shopDomain}`, recipient=`preview@example.com`,
              page=`/pages/request-guide`
            </Text>
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              Subject: {preview.subject}
            </Text>
            <iframe
              title="new-mail-template-preview"
              sandbox=""
              srcDoc={preview.htmlBody}
              style={{
                width: "100%",
                minHeight: "320px",
                border: "1px solid var(--p-color-border-secondary)",
                borderRadius: "12px",
                background: "var(--p-color-bg-surface-secondary)",
              }}
            />
            <Text as="h3" variant="headingSm">
              Plain Text Preview
            </Text>
            <pre
              style={{
                margin: 0,
                padding: "16px",
                whiteSpace: "pre-wrap",
                borderRadius: "12px",
                background: "var(--p-color-bg-surface-secondary)",
                border: "1px solid var(--p-color-border-secondary)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
            >
              {preview.textBody}
            </pre>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
