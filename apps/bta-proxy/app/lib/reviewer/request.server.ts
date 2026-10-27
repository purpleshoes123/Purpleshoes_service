import { getReviewConfig, verifyReviewSession, type ReviewConfig, ReviewAuthError } from './auth.server';
import { reviewStore } from './store.server';
import { respond } from '~/lib/respond';

export async function authenticateReviewer(request: Request): Promise<{ customerId: string; config: ReviewConfig }> {
  let config: ReviewConfig;
  try { config = getReviewConfig(); }
  catch { throw new ReviewAuthError(401, 'AUTH_LOGIN_REQUIRED', 'Review credentials are invalid or expired.'); }
  const session = await verifyReviewSession(request, config, reviewStore());
  return { customerId: session.customerId, config };
}
export function reviewErrorResponse(error: unknown, request: Request): Response {
  const known = error instanceof ReviewAuthError;
  const response = respond.withNoStore(respond.fail(known ? error.code : 'REVIEW_UNAVAILABLE',
    known ? error.message : 'Review sign-in is temporarily unavailable.', undefined,
    known ? error.status : 503, respond.getCorrelationId(request)));
  if (known && error.status === 429) response.headers.set('Retry-After', '60');
  return response;
}
