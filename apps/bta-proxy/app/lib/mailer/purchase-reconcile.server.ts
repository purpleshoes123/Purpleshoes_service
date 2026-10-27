import type { PrismaClient } from '@prisma/client';

// Private operator operation. UNKNOWN requires external provider evidence first.
export async function reconcilePurchaseEmail(db: PrismaClient, input: {
  id: string; shop: string; action: 'retry-not-accepted' | 'mark-accepted' | 'retry-preparation';
  evidence: string; providerMessageId?: string;
}) {
  if (!/^purchase_[a-zA-Z0-9-]+$/.test(input.id) || !input.evidence.trim() || input.evidence.length > 200) {
    throw new Error('A purchase ID and non-secret provider/incident evidence reference are required');
  }
  if (input.action === 'mark-accepted' && !input.providerMessageId?.trim()) throw new Error('Provider message ID required');
  const expected = input.action === 'retry-preparation' ? 'BLOCKED' : 'UNKNOWN';
  return db.$transaction(async tx => {
    const row = await tx.purchaseEmailOutbox.findUnique({ where: { id: input.id } });
    if (!row || row.shopDomain !== input.shop || row.status !== expected) throw new Error('Purchase email state does not allow this operation');
    const accepted = input.action === 'mark-accepted';
    const changed = await tx.purchaseEmailOutbox.updateMany({
      where: { id: input.id, shopDomain: input.shop, status: expected },
      data: { status: accepted ? 'SENT' : 'PENDING', attempts: 0, claimToken: null, claimedAt: null,
        availableAt: new Date(), lastError: `OPERATOR_${input.action}:${input.evidence.trim()}` },
    });
    if (!changed.count) throw new Error('Purchase email state changed concurrently');
    await tx.mailSendRequest.updateMany({ where: { id: input.id }, data: accepted ? {
      status: 'SENT', providerMessageId: input.providerMessageId!.trim(), failureCode: null, failureReason: null,
      // Actual delivery time is not invented when reconciling provider acceptance.
    } : { status: 'PENDING', failureCode: null, failureReason: null } });
    return { id: input.id, status: accepted ? 'SENT' : 'PENDING' };
  });
}
