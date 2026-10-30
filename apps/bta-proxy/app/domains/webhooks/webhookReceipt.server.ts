import type { SaveWebhookEventResult } from "./webhookEventStore";

export function webhookReceiptResponse(receipt: SaveWebhookEventResult): Response | null {
  const durable = process.env.DEPLOYMENT_MODE?.trim() === "multi-node";
  if (
    durable &&
    ((!receipt.saved && !receipt.isDuplicate) ||
      (receipt.isDuplicate && receipt.existingStatus !== "PROCESSED"))
  ) {
    // Keep incomplete/unknown events visible for reconciliation. Do not rerun
    // non-idempotent side effects, or silently acknowledge a saved-only event.
    return new Response("Webhook processing requires reconciliation", {
      status: 503,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
  }
  return receipt.isDuplicate ? new Response("OK", { status: 200 }) : null;
}
