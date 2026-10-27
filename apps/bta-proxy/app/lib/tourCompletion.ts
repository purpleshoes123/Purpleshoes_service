export const TOUR_COMPLETION_TAG_PREFIX = "bta-tour-completed-line-";

export function tourCompletionTag(lineItemId: string): string {
  const id = lineItemId.replace(/^gid:\/\/shopify\/LineItem\//, "");
  if (!/^\d+$/.test(id)) throw new Error("Invalid tour line item ID");
  return `${TOUR_COMPLETION_TAG_PREFIX}${id}`;
}

export function isTourLineCompleted(tags: string[], lineItemId?: string | null): boolean {
  if (!lineItemId) return false;
  return tags.includes(tourCompletionTag(lineItemId));
}
