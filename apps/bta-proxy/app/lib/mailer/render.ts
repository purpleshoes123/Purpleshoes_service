type RenderTemplateVariables = {
  shopName: string;
  recipientEmail: string;
  pagePath: string;
  sentAt: string;
  starterKitViewerUrl?: string;
  unsubscribeUrl?: string;
};

export type MailAttachmentLink = {
  fileName: string;
  fileUrl: string;
};

export type RenderMailTemplateInput = {
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  variables: RenderTemplateVariables;
  attachmentLinks?: MailAttachmentLink[];
  includeAttachmentLinks?: boolean;
};

export type RenderMailTemplateResult = {
  subject: string;
  htmlBody: string;
  textBody: string;
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function replaceTemplateVariables(
  template: string,
  variables: RenderTemplateVariables,
  mode: "subject" | "html" | "text"
) {
  const values = {
    "{{ shop.name }}":
      mode === "html" ? escapeHtml(variables.shopName) : variables.shopName,
    "{{ recipient.email }}":
      mode === "html"
        ? escapeHtml(variables.recipientEmail)
        : variables.recipientEmail,
    "{{ page.path }}":
      mode === "html" ? escapeHtml(variables.pagePath) : variables.pagePath,
    "{{ sent_at }}":
      mode === "html" ? escapeHtml(variables.sentAt) : variables.sentAt,
    "{{ starter_kit.viewer_url }}":
      mode === "html"
        ? escapeHtml(variables.starterKitViewerUrl || "")
        : variables.starterKitViewerUrl || "",
    "{{ unsubscribe_url }}":
      mode === "html"
        ? escapeHtml(variables.unsubscribeUrl || "")
        : variables.unsubscribeUrl || "",
    // This Shopify-specific tracking token is not rendered by the mail
    // provider used by BTA. Leaving it untouched exposes the raw token to
    // recipients, so remove it rather than presenting implementation text.
    "{{ open_tracking_block }}": "",
  };

  return Object.entries(values).reduce(
    (result, [token, value]) => result.split(token).join(value),
    template
  );
}

function appendAttachmentLinksToHtml(
  htmlBody: string,
  attachmentLinks: MailAttachmentLink[]
) {
  if (attachmentLinks.length === 0) return htmlBody;

  const items = attachmentLinks
    .map(
      (attachment) =>
        `<li><a href="${escapeHtml(attachment.fileUrl)}">${escapeHtml(
          attachment.fileName
        )}</a></li>`
    )
    .join("");

  return `${htmlBody}<hr /><p><strong>Attachments</strong></p><ul>${items}</ul>`;
}

function appendAttachmentLinksToText(
  textBody: string,
  attachmentLinks: MailAttachmentLink[]
) {
  if (attachmentLinks.length === 0) return textBody;

  const lines = attachmentLinks.map(
    (attachment) => `- ${attachment.fileName}: ${attachment.fileUrl}`
  );

  return `${textBody}\n\nAttachments\n${lines.join("\n")}`.trim();
}

export function renderMailTemplate(
  input: RenderMailTemplateInput
): RenderMailTemplateResult {
  const subject = replaceTemplateVariables(
    input.subject,
    input.variables,
    "subject"
  );
  const htmlBody = replaceTemplateVariables(
    input.htmlBody,
    input.variables,
    "html"
  );
  const baseTextBody = replaceTemplateVariables(
    input.textBody?.trim() || stripHtml(htmlBody),
    input.variables,
    "text"
  );
  const attachmentLinks =
    input.includeAttachmentLinks && input.attachmentLinks
      ? input.attachmentLinks
      : [];

  return {
    subject,
    htmlBody: appendAttachmentLinksToHtml(htmlBody, attachmentLinks),
    textBody: appendAttachmentLinksToText(baseTextBody, attachmentLinks),
  };
}
