import { randomUUID } from 'node:crypto';
import type { PrismaClient, PurchaseEmailOutbox } from '@prisma/client';
import type { MailSendInput, MailSendResult } from './provider';
import { getMailerEnv, getMissingProviderConfigKeys } from './env';
import { getMailProviderRuntimeIssue } from './provider';
import { renderPurchaseEmail } from './purchase-template.server';
import type { PurchaseReadiness } from './purchase-readiness.server';

type WorkerDependencies = {
  prisma: PrismaClient;
  shop: string;
  prepare: (row: PurchaseEmailOutbox) => Promise<PurchaseReadiness>;
  send: (input: MailSendInput) => Promise<MailSendResult>;
  now?: () => Date;
  shouldStop?: () => boolean;
};

export async function processPurchaseEmailBatch(deps: WorkerDependencies) {
  const { prisma, shop } = deps;
  const now = deps.now || (() => new Date());
  const env = getMailerEnv();
  if (!env.fromEmail || getMissingProviderConfigKeys(env).length || getMailProviderRuntimeIssue(env.provider)) {
    throw new Error('Purchase email provider is not configured');
  }
  // PREPARING has not called a mail provider; safe to reclaim after a crash.
  await prisma.purchaseEmailOutbox.updateMany({
    where: { shopDomain: shop, status: 'PREPARING', claimedAt: { lt: new Date(now().getTime() - 300000) } },
    data: { status: 'PENDING', claimToken: null, lastError: 'PREPARATION_INTERRUPTED' },
  });
  // SENDING may have been accepted externally. Never turn it back into PENDING.
  await prisma.$transaction(async tx => {
    const stale = await tx.purchaseEmailOutbox.findMany({
      where: { shopDomain: shop, status: 'SENDING', claimedAt: { lt: new Date(now().getTime() - 600000) } },
      select: { id: true }, take: 100,
    });
    const ids = stale.map(row => row.id);
    if (!ids.length) return;
    await tx.purchaseEmailOutbox.updateMany({ where: { id: { in: ids }, status: 'SENDING' }, data: { status: 'UNKNOWN', lastError: 'DELIVERY_INTERRUPTED' } });
    await tx.mailSendRequest.updateMany({ where: { id: { in: ids }, status: 'PENDING' }, data: { status: 'BLOCKED', failureCode: 'PURCHASE_DELIVERY_UNKNOWN' } });
  });
  const rows = await prisma.purchaseEmailOutbox.findMany({
    where: { shopDomain: shop, status: 'PENDING', availableAt: { lte: now() } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20,
  });
  const counts = { sent: 0, deferred: 0, canceled: 0, unknown: 0, blocked: 0 };
  for (const row of rows) {
    if (deps.shouldStop?.()) break;
    const token = randomUUID();
    const claimed = await prisma.purchaseEmailOutbox.updateMany({
      where: { id: row.id, status: 'PENDING', availableAt: { lte: now() } },
      data: { status: 'PREPARING', claimToken: token, claimedAt: now(), attempts: { increment: 1 } },
    });
    if (!claimed.count) continue;
    const ownership = { id: row.id, status: 'PREPARING', claimToken: token };
    let input: MailSendInput;
    try {
      const prepared = await deps.prepare(row);
      if (prepared.status === 'CANCELED') {
        await prisma.purchaseEmailOutbox.updateMany({ where: ownership, data: { status: 'CANCELED', claimToken: null } });
        await prisma.mailSendRequest.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'BLOCKED', failureCode: 'PURCHASE_CANCELED' } });
        counts.canceled++; continue;
      }
      if (prepared.status !== 'READY') throw new Error('PURCHASE_NOT_READY');
      const rendered = renderPurchaseEmail({ ...row, email: prepared.email });
      // The same ID also supports the existing signed, confirmed marketing opt-out page.
      const snapshot = await prisma.mailSendRequest.upsert({
        where: { id: row.id }, update: {},
        create: {
          id: row.id, shopDomain: row.shopDomain, templateId: `purchase-static-${row.kind}`,
          templateNameSnapshot: row.kind, templateSlugSnapshot: `purchase-${row.kind.toLowerCase()}`,
          attachmentModeSnapshot: 'NONE', requestSource: 'INTERNAL_TRIGGER', requestKey: row.id,
          recipientEmail: prepared.email, status: 'PENDING', emailProvider: env.provider,
          subjectSnapshot: rendered.subject, htmlBodySnapshot: rendered.htmlBody, textBodySnapshot: rendered.textBody,
          fromNameSnapshot: 'Purple Shoes', replyToSnapshot: 'support@kpurpleshoes.com',
        },
      });
      // Do not reuse an old snapshot after an operator changes the order recipient.
      if (snapshot.recipientEmail !== prepared.email) throw new Error('PURCHASE_RECIPIENT_CHANGED');
      input = {
        from: { email: env.fromEmail, name: 'Purple Shoes' }, recipient: { email: snapshot.recipientEmail },
        subject: snapshot.subjectSnapshot!, htmlBody: snapshot.htmlBodySnapshot, textBody: snapshot.textBodySnapshot,
        replyTo: 'support@kpurpleshoes.com', metadata: { purchase_email_id: row.id }, disableAutomaticRetries: true,
      };
    } catch {
      const attempts = row.attempts + 1;
      const blocked = attempts >= 12;
      await prisma.purchaseEmailOutbox.updateMany({ where: ownership, data: {
        status: blocked ? 'BLOCKED' : 'PENDING', claimToken: null,
        lastError: 'PURCHASE_PREPARATION_FAILED', availableAt: new Date(now().getTime() + Math.min(3600000, 60000 * 2 ** Math.min(attempts - 1, 6))),
      } });
      if (blocked) await prisma.mailSendRequest.updateMany({ where: { id: row.id, status: 'PENDING' }, data: {
        status: 'BLOCKED', failureCode: 'PURCHASE_PREPARATION_FAILED',
      } });
      counts[blocked ? 'blocked' : 'deferred']++; continue;
    }
    const sending = await prisma.purchaseEmailOutbox.updateMany({
      where: ownership, data: { status: 'SENDING', claimedAt: now() },
    });
    if (!sending.count) continue; // Lease lost to a different worker: no provider call.
    try {
      const result = await deps.send(input);
      if (!result.messageId) throw new Error('Missing provider acceptance ID');
      await prisma.$transaction(async tx => {
        await tx.mailSendRequest.update({ where: { id: row.id }, data: {
          status: 'SENT', emailProvider: result.provider, providerMessageId: result.messageId, sentAt: new Date(result.acceptedAt),
        } });
        await tx.purchaseEmailOutbox.updateMany({ where: { id: row.id, status: 'SENDING', claimToken: token }, data: {
          status: 'SENT', claimToken: null, lastError: null,
        } });
      });
      counts.sent++;
    } catch {
      // Includes timeouts AND a DB failure after external acceptance. No blind retry.
      await prisma.$transaction(async tx => {
        await tx.purchaseEmailOutbox.updateMany({ where: { id: row.id, status: 'SENDING', claimToken: token }, data: {
          status: 'UNKNOWN', lastError: 'PURCHASE_DELIVERY_UNKNOWN',
        } });
        await tx.mailSendRequest.updateMany({ where: { id: row.id, status: 'PENDING' }, data: {
          status: 'BLOCKED', failureCode: 'PURCHASE_DELIVERY_UNKNOWN', failureReason: 'Check provider acceptance before any manual retry.',
        } });
      });
      counts.unknown++;
    }
  }
  return counts;
}
