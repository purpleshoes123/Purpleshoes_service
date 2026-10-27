import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMailTemplate } from './render';
import { createMailUnsubscribeUrl } from './unsubscribe.server';

export function renderPurchaseEmail(params: { kind: string; shopDomain: string; id: string; email: string }) {
  const templates: Record<string, { file: string; subject: string }> = {
    GUIDE_KIT: { file: 'korea-guide-kit.html', subject: 'Your Korea Guide Kit Is Ready — Your Korea Trip, All Set' },
    GUIDE_ONLY: { file: 'guide-only.html', subject: 'Your Purchase Is Complete — Your Korea Guide Is Ready' },
    TOUR: { file: 'tour.html', subject: 'Your Tour Is Confirmed — See You in Korea' },
    GUIDE_EXTENSION: { file: 'extension.html', subject: 'Your Access Extension Is Active' },
  };
  const template = Object.hasOwn(templates, params.kind) ? templates[params.kind] : undefined;
  if (!template) throw new Error('Unknown purchase email kind');
  // Fixed, reviewed purchase/access templates only. Never render an arbitrary admin marketing template.
  const root = resolve(process.cwd(), 'mail-templates/shopify-messaging-ppt-20260911');
  const html = readFileSync(resolve(root, template.file), 'utf8')
    .replace('{{ purchase_app_qr }}', readFileSync(resolve(root, 'app-download-qr.html'), 'utf8').trim());
  const unsubscribeUrl = createMailUnsubscribeUrl({ shopDomain: params.shopDomain, sendRequestId: params.id });
  const rendered = renderMailTemplate({
    subject: template.subject,
    htmlBody: html,
    variables: { shopName: 'Purple Shoes', recipientEmail: params.email, pagePath: '', sentAt: '', unsubscribeUrl },
  });
  if (/\{[{%]/.test(rendered.htmlBody)) throw new Error('Unresolved purchase template token');
  // Plain-text mail must retain working destinations, not just stripped anchor labels.
  rendered.textBody += params.kind === 'TOUR'
    ? '\n\nCheck My Reservation: https://kpurpleshoes.com/pages/mypage?tab=booking'
    : '\n\nOpen your purchased content: https://kpurpleshoes.com/pages/pdfviewer' +
      '\nApp Store: https://apps.apple.com/app/id6759947452' +
      '\nGoogle Play: https://play.google.com/store/apps/details?id=com.kpurpleshoes.guidekitviewer';
  rendered.textBody += '\nWebsite: https://kpurpleshoes.com\nPrivacy Policy: https://kpurpleshoes.com/policies/privacy-policy' +
    `\nUnsubscribe from marketing emails: ${unsubscribeUrl}`;
  return rendered;
}
