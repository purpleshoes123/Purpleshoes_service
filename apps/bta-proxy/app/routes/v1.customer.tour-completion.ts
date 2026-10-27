import type { ActionFunctionArgs } from "react-router";
import { parseTourOrderIds, readCustomerTourCompletion, TOUR_SHOP, TourCompletionRequestError, verifyTourCustomer } from '~/lib/customerTourCompletion.server';
import { getAdminApiClient } from '~/lib/shopifyAdmin';
import { respond } from '~/lib/respond';
import { enforceStorefrontCustomerRateLimit } from '~/lib/rateLimit/storefrontCustomerRateLimit.server';
import { hasReviewBearer, ReviewAuthError } from '~/lib/reviewer/auth.server';
import { authenticateReviewer, reviewErrorResponse } from '~/lib/reviewer/request.server';

export async function action({ request }: ActionFunctionArgs) {
  const correlationId = respond.getCorrelationId(request);
  const fail = (status: number, code: string, message: string) => respond.withNoStore(respond.fail(code, message, undefined, status, correlationId));
  if (request.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
  try {
    // Verify identity before any Admin query. Never trust a client customer ID.
    const customerId = hasReviewBearer(request)
      ? (await authenticateReviewer(request)).customerId
      : await verifyTourCustomer(request.headers.get('Authorization'));
    const limited = await enforceStorefrontCustomerRateLimit({ shop: TOUR_SHOP, customerId, bucket: 'mypage-read', path: '/v1/customer/tour-completion', correlationId });
    if (limited) return limited;
    const body = await request.text();
    if (body.length > 8192) return fail(400, 'VALIDATION_ERROR', 'Request is too large.');
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return fail(400, 'VALIDATION_ERROR', 'Expected JSON.'); }
    const ids = parseTourOrderIds(parsed);
    const admin = await getAdminApiClient(TOUR_SHOP);
    if (!admin) return fail(503, 'SERVICE_UNAVAILABLE', 'Tour status is temporarily unavailable.');
    return respond.withNoStore(respond.ok(await readCustomerTourCompletion(admin, customerId, ids), { correlationId }));
  } catch (error) {
    if (error instanceof ReviewAuthError) return reviewErrorResponse(error, request);
    if (error instanceof TourCompletionRequestError) return fail(error.status, error.code, error.message);
    // Do not log OAuth tokens, customer/order IDs or upstream responses.
    return fail(502, 'SHOPIFY_ADMIN_API_ERROR', 'Tour status is temporarily unavailable.');
  }
}

export function loader() {
  return respond.withNoStore(respond.fail('METHOD_NOT_ALLOWED', 'Use POST.', undefined, 405));
}
