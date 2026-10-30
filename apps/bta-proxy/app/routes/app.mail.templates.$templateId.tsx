import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { json } from "~/lib/httpJson";
import { Form, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import { useState } from "react";
import {
  Banner,
  Badge,
  BlockStack,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineStack,
  List,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "~/db.server";
import {
  parseMailTemplateAttachmentMoveForm,
  parseMailTemplateAttachmentMutationForm,
  parseMailTemplateEditorForm,
  parseMailTemplateExternalAttachmentForm,
  parseMailTemplateReuseAttachmentForm,
  parseMailTemplateTestSendForm,
} from "~/domains/mail/adminForms.server.ts";
import {
  assertCanAppendTemplateAttachment,
  assertNoDuplicateTemplateAttachment,
  buildMovedTemplateAttachmentIds,
  buildNextTemplateAttachmentSortOrder,
  inspectExternalMailAttachment,
} from "~/domains/mail/adminAttachments.server.ts";
import {
  MAILER_ATTACHMENT_MODE_VALUES,
  MAILER_ROUTE_PATHS,
  MAILER_TEMPLATE_VARIABLES,
} from "~/domains/mail/contracts";
import { withEmbeddedSearch } from "~/domains/guide-viewer/embeddedPath";
import { getMailerEnvSummary } from "~/domains/mail/env";
import { renderMailTemplate } from "~/domains/mail/render";
import { sendAdminTemplateTestMail } from "~/domains/mail/service.server.ts";
import {
  getReusableMailerFileById,
  inferMailerMimeTypeFromFileName,
  listReusableMailerFiles,
  uploadMailerAttachmentToShopifyFiles,
} from "~/domains/mail/shopifyFiles.server.ts";
import {
  createTemplateAttachment,
  deleteTemplateAttachment,
  getTemplateDetail,
  isTemplateSlugTaken,
  reorderTemplateAttachments,
  updateTemplate,
} from "~/domains/mail/templateStore.server.ts";
import { listSendRequests } from "~/domains/mail/sendRequestStore.server.ts";
import { authenticate } from "~/shopify.server";

type ActionIntent =
  | "update_template"
  | "test_send"
  | "upload_attachment"
  | "attach_shopify_file"
  | "attach_external_url"
  | "delete_attachment"
  | "move_attachment"
  | "unknown";

type ActionData =
  | {
      ok: true;
      intent: Exclude<ActionIntent, "unknown">;
      successMessage: string;
      requestId?: string;
      sentAt?: string;
    }
  | {
      ok: false;
      intent: ActionIntent;
      errorMessage: string;
      fieldErrors?: Record<string, string>;
    };

function extractFieldErrors(error: unknown) {
  if (!error || typeof error !== "object" || !("issues" in error)) {
    return {};
  }

  const issues = (error as { issues: Array<{ path?: Array<string | number>; message: string }> })
    .issues;
  const fieldErrors: Record<string, string> = {};

  for (const issue of issues) {
    const field = String(issue.path?.[0] || "");
    if (field && !fieldErrors[field]) {
      fieldErrors[field] = issue.message;
    }
  }

  return fieldErrors;
}

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return value instanceof Blob && typeof (value as File).name === "string";
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const templateId = params.templateId || "";
  const template = await getTemplateDetail(db, templateId);

  if (!template || template.shopDomain !== auth.session.shop) {
    throw new Response("Not Found", { status: 404 });
  }

  const recentLogs = await listSendRequests(db, {
    shopDomain: auth.session.shop,
    templateId: template.id,
    limit: 5,
  });
  const attachmentPolicy = getMailerEnvSummary().attachmentPolicy;

  let reusableFiles: Array<{
    id: string;
    shopifyFileId: string;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    sizeBytes: number;
    previewUrl: string | null;
    contentType: "IMAGE" | "FILE" | "VIDEO";
    createdAt: string | null;
  }> = [];
  let reusableFilesError: string | null = null;

  try {
    reusableFiles = (
      await listReusableMailerFiles(auth.admin, {
        limit: 8,
        maxAttachmentBytes: attachmentPolicy.maxAttachmentBytes,
      })
    ).map((item) => ({
      id: item.id,
      shopifyFileId: item.shopifyFileId,
      fileName: item.fileName,
      fileUrl: item.fileUrl,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      previewUrl: item.previewUrl,
      contentType: item.contentType,
      createdAt: item.createdAt,
    }));
  } catch (error) {
    reusableFilesError =
      error instanceof Error ? error.message : "Shopify Files 목록을 불러오지 못했습니다.";
  }

  return json({
    shopDomain: auth.session.shop,
    template: {
      id: template.id,
      name: template.name,
      slug: template.slug,
      subject: template.subject,
      htmlBody: template.htmlBody,
      textBody: template.textBody || "",
      fromName: template.fromName || "",
      replyTo: template.replyTo || "",
      isActive: template.isActive,
      attachmentMode: template.attachmentMode,
      deletedAt: template.deletedAt?.toISOString() || null,
      attachments: template.attachments.map((item) => ({
        id: item.id,
        storageType: item.storageType,
        shopifyFileId: item.shopifyFileId,
        fileName: item.fileName,
        fileUrl: item.fileUrl,
        mimeType: item.mimeType,
        sizeBytes: item.fileSizeBytes,
        sortOrder: item.sortOrder,
      })),
      updatedAt: template.updatedAt.toISOString(),
    },
    recentLogs: recentLogs.items.map((item) => ({
      id: item.id,
      status: item.status,
      recipientEmail: item.maskedRecipientEmail,
      createdAt: item.createdAt.toISOString(),
    })),
    attachmentPolicy,
    reusableFiles,
    reusableFilesError,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const auth = await authenticate.admin(request);
  const templateId = params.templateId || "";
  const template = await getTemplateDetail(db, templateId);

  if (!template || template.shopDomain !== auth.session.shop) {
    throw new Response("Not Found", { status: 404 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "").trim();
  const attachmentPolicy = getMailerEnvSummary().attachmentPolicy;

  try {
    if (intent === "update_template") {
      const input = parseMailTemplateEditorForm(formData);
      const slugTaken = await isTemplateSlugTaken(db, {
        shopDomain: auth.session.shop,
        slug: input.slug,
        excludeTemplateId: template.id,
      });

      if (slugTaken) {
        return json<ActionData>({
          ok: false,
          intent,
          errorMessage: "이미 사용 중인 템플릿 슬러그입니다.",
          fieldErrors: {
            slug: "이미 사용 중인 템플릿 슬러그입니다.",
          },
        });
      }

      await updateTemplate(db, template.id, input);
      return json<ActionData>({
        ok: true,
        intent,
        successMessage: "템플릿이 저장되었습니다.",
      });
    }

    if (intent === "test_send") {
      const input = parseMailTemplateTestSendForm(formData);
      const result = await sendAdminTemplateTestMail({
        shopDomain: auth.session.shop,
        templateId: template.id,
        recipientEmail: input.recipientEmail,
        recipientName: input.recipientName,
        prisma: db,
      });

      return json<ActionData>({
        ok: true,
        intent,
        successMessage: "테스트 메일을 발송했습니다.",
        requestId: result.requestId,
        sentAt: result.sentAt,
      });
    }

    if (intent === "upload_attachment") {
      const fileValue = formData.get("attachmentFile");

      if (!isUploadFile(fileValue) || !String(fileValue.name || "").trim()) {
        return json<ActionData>({
          ok: false,
          intent,
          errorMessage: "업로드할 첨부파일을 선택하세요.",
          fieldErrors: {
            attachmentFile: "업로드할 첨부파일을 선택하세요.",
          },
        });
      }

      const fileName = String(fileValue.name || "").trim();
      const mimeType =
        String(fileValue.type || "")
          .trim()
          .toLowerCase() ||
        inferMailerMimeTypeFromFileName(fileName) ||
        "";

      assertCanAppendTemplateAttachment(template.attachments, fileValue.size, attachmentPolicy);

      const uploadedFile = await uploadMailerAttachmentToShopifyFiles(
        auth.admin,
        {
          filename: fileName,
          mimeType,
          sizeBytes: fileValue.size,
          data: Buffer.from(await fileValue.arrayBuffer()),
        },
        {
          maxAttachmentBytes: attachmentPolicy.maxAttachmentBytes,
        },
      );

      assertNoDuplicateTemplateAttachment(template.attachments, {
        shopifyFileId: uploadedFile.shopifyFileId,
        fileUrl: uploadedFile.fileUrl,
      });

      await createTemplateAttachment(db, {
        templateId: template.id,
        storageType: "SHOPIFY_FILE",
        shopifyFileId: uploadedFile.shopifyFileId,
        fileUrl: uploadedFile.fileUrl,
        fileName: uploadedFile.fileName,
        mimeType: uploadedFile.mimeType,
        fileSizeBytes: uploadedFile.sizeBytes,
        sortOrder: buildNextTemplateAttachmentSortOrder(template.attachments),
      });

      return json<ActionData>({
        ok: true,
        intent,
        successMessage: "첨부파일을 업로드하고 템플릿에 연결했습니다.",
      });
    }

    if (intent === "attach_shopify_file") {
      const input = parseMailTemplateReuseAttachmentForm(formData);
      const selectedFile = await getReusableMailerFileById(
        auth.admin,
        input.shopifyFileId,
        attachmentPolicy.maxAttachmentBytes,
      );

      if (!selectedFile) {
        return json<ActionData>({
          ok: false,
          intent,
          errorMessage: "선택한 Shopify 파일을 찾지 못했거나 첨부 정책을 초과했습니다.",
          fieldErrors: {
            shopifyFileId: "선택한 Shopify 파일을 다시 확인하세요.",
          },
        });
      }

      assertCanAppendTemplateAttachment(
        template.attachments,
        selectedFile.sizeBytes,
        attachmentPolicy,
      );
      assertNoDuplicateTemplateAttachment(template.attachments, {
        shopifyFileId: selectedFile.shopifyFileId,
        fileUrl: selectedFile.fileUrl,
      });

      await createTemplateAttachment(db, {
        templateId: template.id,
        storageType: "SHOPIFY_FILE",
        shopifyFileId: selectedFile.shopifyFileId,
        fileUrl: selectedFile.fileUrl,
        fileName: selectedFile.fileName,
        mimeType: selectedFile.mimeType,
        fileSizeBytes: selectedFile.sizeBytes,
        sortOrder: buildNextTemplateAttachmentSortOrder(template.attachments),
      });

      return json<ActionData>({
        ok: true,
        intent,
        successMessage: "기존 Shopify 파일을 첨부에 연결했습니다.",
      });
    }

    if (intent === "attach_external_url") {
      const input = parseMailTemplateExternalAttachmentForm(formData);
      const inspectedAttachment = await inspectExternalMailAttachment({
        fileUrl: input.fileUrl,
        fileName: input.fileName,
        maxAttachmentBytes: attachmentPolicy.maxAttachmentBytes,
      });

      assertCanAppendTemplateAttachment(
        template.attachments,
        inspectedAttachment.fileSizeBytes,
        attachmentPolicy,
      );
      assertNoDuplicateTemplateAttachment(template.attachments, inspectedAttachment);

      await createTemplateAttachment(db, {
        templateId: template.id,
        storageType: inspectedAttachment.storageType,
        shopifyFileId: inspectedAttachment.shopifyFileId,
        fileUrl: inspectedAttachment.fileUrl,
        fileName: inspectedAttachment.fileName,
        mimeType: inspectedAttachment.mimeType,
        fileSizeBytes: inspectedAttachment.fileSizeBytes,
        sortOrder: buildNextTemplateAttachmentSortOrder(template.attachments),
      });

      return json<ActionData>({
        ok: true,
        intent,
        successMessage: "외부 URL 첨부를 템플릿에 연결했습니다.",
      });
    }

    if (intent === "delete_attachment") {
      const input = parseMailTemplateAttachmentMutationForm(formData);
      const attachment = template.attachments.find((item) => item.id === input.attachmentId);

      if (!attachment) {
        return json<ActionData>({
          ok: false,
          intent,
          errorMessage: "삭제할 첨부파일을 찾지 못했습니다.",
        });
      }

      await deleteTemplateAttachment(db, input.attachmentId);

      return json<ActionData>({
        ok: true,
        intent,
        successMessage: "첨부파일 연결을 해제했습니다.",
      });
    }

    if (intent === "move_attachment") {
      const input = parseMailTemplateAttachmentMoveForm(formData);
      const currentAttachmentIds = template.attachments.map((item) => item.id);
      const reorderedAttachmentIds = buildMovedTemplateAttachmentIds(
        template.attachments,
        input.attachmentId,
        input.direction,
      );

      if (
        reorderedAttachmentIds.some(
          (attachmentId, index) => attachmentId !== currentAttachmentIds[index],
        )
      ) {
        await reorderTemplateAttachments(db, template.id, reorderedAttachmentIds);
      }

      return json<ActionData>({
        ok: true,
        intent,
        successMessage: "첨부파일 순서를 변경했습니다.",
      });
    }

    return json<ActionData>({
      ok: false,
      intent: "unknown",
      errorMessage: "지원하지 않는 작업입니다.",
    });
  } catch (error) {
    return json<ActionData>({
      ok: false,
      intent:
        intent === "update_template" ||
        intent === "test_send" ||
        intent === "upload_attachment" ||
        intent === "attach_shopify_file" ||
        intent === "attach_external_url" ||
        intent === "delete_attachment" ||
        intent === "move_attachment"
          ? intent
          : "unknown",
      errorMessage: error instanceof Error ? error.message : "요청 처리 중 오류가 발생했습니다.",
      fieldErrors: extractFieldErrors(error),
    });
  }
};

export default function MailTemplateDetailPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const location = useLocation();
  const toInApp = (path: string) => withEmbeddedSearch(path, location.search);
  const templateLogsPath = `${MAILER_ROUTE_PATHS.adminLogs}?templateId=${encodeURIComponent(
    data.template.id,
  )}`;

  const [name, setName] = useState(data.template.name);
  const [slug, setSlug] = useState(data.template.slug);
  const [subject, setSubject] = useState(data.template.subject);
  const [htmlBody, setHtmlBody] = useState(data.template.htmlBody);
  const [textBody, setTextBody] = useState(data.template.textBody);
  const [fromName, setFromName] = useState(data.template.fromName);
  const [replyTo, setReplyTo] = useState(data.template.replyTo);
  const [attachmentMode, setAttachmentMode] = useState(data.template.attachmentMode);
  const [isActive, setIsActive] = useState(data.template.isActive);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [selectedReusableFileId, setSelectedReusableFileId] = useState(
    data.reusableFiles[0]?.shopifyFileId || "",
  );
  const [externalFileUrl, setExternalFileUrl] = useState("");
  const [externalFileName, setExternalFileName] = useState("");
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
    attachmentLinks: data.template.attachments.map((item) => ({
      fileName: item.fileName,
      fileUrl: item.fileUrl,
    })),
    includeAttachmentLinks: attachmentMode === "LINK_ONLY" || attachmentMode === "MIXED",
  });

  const fieldErrors = actionData?.ok ? {} : actionData?.fieldErrors || {};
  const lastTestSend = actionData?.ok && actionData.intent === "test_send" ? actionData : null;
  const submittingIntent = navigation.formData
    ? String(navigation.formData.get("intent") || "")
    : "";
  const submittingAttachmentId = navigation.formData
    ? String(navigation.formData.get("attachmentId") || "")
    : "";
  const submittingDirection = navigation.formData
    ? String(navigation.formData.get("direction") || "")
    : "";

  return (
    <Page>
      <TitleBar title="메일 템플릿 상세" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200">
            <Button url={toInApp(MAILER_ROUTE_PATHS.adminTemplates)}>템플릿 목록으로</Button>
            <Button url={toInApp(templateLogsPath)}>이 템플릿 전체 로그 보기</Button>
          </InlineStack>
          <Badge tone={data.template.isActive ? "success" : "attention"}>
            {data.template.isActive ? "활성" : "비활성"}
          </Badge>
        </InlineStack>

        {actionData ? (
          actionData.ok ? (
            <Banner tone="success" title="Saved">
              <p>{actionData.successMessage}</p>
              {lastTestSend ? (
                <p>
                  Request ID: {lastTestSend.requestId} / sentAt: {lastTestSend.sentAt}
                </p>
              ) : null}
            </Banner>
          ) : (
            <Banner tone="critical" title="Action failed">
              <p>{actionData.errorMessage}</p>
            </Banner>
          )
        ) : null}

        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="update_template" />
            <BlockStack gap="400">
              <Text as="h1" variant="headingLg">
                Template: {data.template.name}
              </Text>
              <Text as="p" variant="bodyMd">
                Updated at: {data.template.updatedAt}
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

              <Text as="p" variant="bodyMd">
                Supported variables: {MAILER_TEMPLATE_VARIABLES.join(", ")}
              </Text>

              <Button submit variant="primary" loading={submittingIntent === "update_template"}>
                Save Template
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
              title="mail-template-preview"
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

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Attachments
            </Text>
            <Text as="p" variant="bodyMd">
              정책: 템플릿당 최대 {data.attachmentPolicy.maxTemplateAttachmentCount}개, 파일당{" "}
              {data.attachmentPolicy.maxAttachmentBytes} bytes, 총{" "}
              {data.attachmentPolicy.maxTotalAttachmentBytes} bytes
            </Text>
            {data.template.attachments.length > 0 ? (
              <List type="bullet">
                {data.template.attachments.map((item, index) => (
                  <List.Item key={item.id}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <BlockStack gap="100">
                          <Text as="span" variant="bodyMd" fontWeight="semibold">
                            <a href={item.fileUrl} target="_blank" rel="noreferrer">
                              {item.fileName}
                            </a>
                          </Text>
                          <InlineStack gap="200" blockAlign="center">
                            <Badge>{item.storageType}</Badge>
                            <Text as="span" variant="bodySm">
                              {item.mimeType} / {item.sizeBytes} bytes
                            </Text>
                          </InlineStack>
                        </BlockStack>
                        <InlineStack gap="200">
                          <Form method="post">
                            <input type="hidden" name="intent" value="move_attachment" />
                            <input type="hidden" name="attachmentId" value={item.id} />
                            <input type="hidden" name="direction" value="up" />
                            <Button
                              submit
                              size="slim"
                              disabled={index === 0}
                              loading={
                                submittingIntent === "move_attachment" &&
                                submittingAttachmentId === item.id &&
                                submittingDirection === "up"
                              }
                            >
                              Move Up
                            </Button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="move_attachment" />
                            <input type="hidden" name="attachmentId" value={item.id} />
                            <input type="hidden" name="direction" value="down" />
                            <Button
                              submit
                              size="slim"
                              disabled={index === data.template.attachments.length - 1}
                              loading={
                                submittingIntent === "move_attachment" &&
                                submittingAttachmentId === item.id &&
                                submittingDirection === "down"
                              }
                            >
                              Move Down
                            </Button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="delete_attachment" />
                            <input type="hidden" name="attachmentId" value={item.id} />
                            <Button
                              submit
                              size="slim"
                              tone="critical"
                              loading={
                                submittingIntent === "delete_attachment" &&
                                submittingAttachmentId === item.id
                              }
                            >
                              Remove
                            </Button>
                          </Form>
                        </InlineStack>
                      </InlineStack>
                    </BlockStack>
                  </List.Item>
                ))}
              </List>
            ) : (
              <Text as="p" variant="bodyMd">
                연결된 첨부파일이 없습니다.
              </Text>
            )}

            {data.reusableFilesError ? (
              <Banner tone="warning" title="Shopify Files lookup failed">
                <p>{data.reusableFilesError}</p>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Upload New File
                </Text>
                <Form method="post" encType="multipart/form-data">
                  <input type="hidden" name="intent" value="upload_attachment" />
                  <BlockStack gap="300">
                    <input
                      name="attachmentFile"
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,.webp,.mp4,.mov,.webm"
                    />
                    {fieldErrors.attachmentFile ? (
                      <Text as="p" variant="bodyMd" tone="critical">
                        {fieldErrors.attachmentFile}
                      </Text>
                    ) : null}
                    <Button submit loading={submittingIntent === "upload_attachment"}>
                      Upload and Attach
                    </Button>
                  </BlockStack>
                </Form>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Reuse Shopify Files
                </Text>
                {data.reusableFiles.length > 0 ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="attach_shopify_file" />
                    <BlockStack gap="300">
                      <Select
                        label="Reusable file"
                        name="shopifyFileId"
                        options={data.reusableFiles.map((item) => ({
                          label: `${item.fileName} (${item.mimeType}, ${item.sizeBytes} bytes)`,
                          value: item.shopifyFileId,
                        }))}
                        value={selectedReusableFileId}
                        onChange={setSelectedReusableFileId}
                        error={fieldErrors.shopifyFileId}
                      />
                      <Button submit loading={submittingIntent === "attach_shopify_file"}>
                        Attach Selected File
                      </Button>
                    </BlockStack>
                  </Form>
                ) : (
                  <Text as="p" variant="bodyMd">
                    재사용 가능한 Shopify Files 항목이 아직 없습니다.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Attach External URL
                </Text>
                <Form method="post">
                  <input type="hidden" name="intent" value="attach_external_url" />
                  <FormLayout>
                    <TextField
                      label="File URL"
                      name="fileUrl"
                      value={externalFileUrl}
                      onChange={setExternalFileUrl}
                      autoComplete="off"
                      error={fieldErrors.fileUrl}
                    />
                    <TextField
                      label="File name override"
                      name="fileName"
                      value={externalFileName}
                      onChange={setExternalFileName}
                      autoComplete="off"
                      helpText="비워두면 URL 경로의 마지막 파일명을 사용합니다."
                      error={fieldErrors.fileName}
                    />
                  </FormLayout>
                  <Button submit loading={submittingIntent === "attach_external_url"}>
                    Attach External File
                  </Button>
                </Form>
              </BlockStack>
            </Card>
          </BlockStack>
        </Card>

        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="test_send" />
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Test Send
              </Text>
              <Text as="p" variant="bodyMd">
                비활성 템플릿도 테스트 발송할 수 있습니다. 현재 템플릿 본문과 현재 첨부 설정을
                기준으로 발송됩니다.
              </Text>
              <FormLayout>
                <TextField
                  label="Recipient email"
                  name="recipientEmail"
                  type="email"
                  value={recipientEmail}
                  onChange={setRecipientEmail}
                  autoComplete="email"
                  error={fieldErrors.recipientEmail}
                />
                <TextField
                  label="Recipient name"
                  name="recipientName"
                  value={recipientName}
                  onChange={setRecipientName}
                  autoComplete="off"
                  error={fieldErrors.recipientName}
                />
              </FormLayout>
              <Button submit loading={submittingIntent === "test_send"}>
                Send Test Mail
              </Button>
            </BlockStack>
          </Form>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              최근 발송 로그
            </Text>
            {data.recentLogs.length > 0 ? (
              <List type="bullet">
                {data.recentLogs.map((item) => (
                  <List.Item key={item.id}>
                    <InlineStack gap="200" blockAlign="center">
                      <Button
                        variant="plain"
                        url={toInApp(MAILER_ROUTE_PATHS.adminLogDetail(item.id))}
                      >
                        {item.status}
                      </Button>
                      <Text as="span" variant="bodyMd">
                        {item.recipientEmail} / {item.createdAt}
                      </Text>
                    </InlineStack>
                  </List.Item>
                ))}
              </List>
            ) : (
              <Text as="p" variant="bodyMd">
                이 템플릿 기준 로그가 아직 없습니다.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
