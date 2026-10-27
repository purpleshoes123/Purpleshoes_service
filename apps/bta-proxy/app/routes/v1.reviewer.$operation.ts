import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createReviewSession, getReviewConfig, revokeReviewSession, ReviewAuthError } from '~/lib/reviewer/auth.server';
import { checkDedicatedAccount, reviewOrders, reviewProfile } from '~/lib/reviewer/customer.server';
import { authenticateReviewer, reviewErrorResponse } from '~/lib/reviewer/request.server';
import { reviewStore } from '~/lib/reviewer/store.server';
import { respond } from '~/lib/respond';

async function boundedJson(request: Request): Promise<{ username: string; password: string }> {
  const invalid = () => new ReviewAuthError(400, 'VALIDATION_ERROR', 'Expected username and password.');
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2048) { await reader.cancel(); throw invalid(); }
      chunks.push(chunk.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string' ||
      Object.keys(body).some(key => key !== 'username' && key !== 'password')) throw invalid();
    return body;
  } catch (error) { if (error instanceof ReviewAuthError) throw error; throw invalid(); }
  finally { reader.releaseLock(); }
}
export async function action({ request, params }: ActionFunctionArgs) {
  try {
    if (request.method !== 'POST') throw new ReviewAuthError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
    if (params.operation === 'login') {
      const config = getReviewConfig();
      const body = await boundedJson(request);
      const result = await createReviewSession(body.username, body.password, config, reviewStore(), checkDedicatedAccount);
      return respond.withNoStore(respond.ok(result, { correlationId: respond.getCorrelationId(request) }));
    }
    if (params.operation === 'logout') {
      await revokeReviewSession(request, reviewStore());
      return respond.withNoStore(respond.ok({ signedOut: true }, { correlationId: respond.getCorrelationId(request) }));
    }
    throw new ReviewAuthError(404, 'NOT_FOUND', 'Not found.');
  } catch (error) { return reviewErrorResponse(error, request); }
}
export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    if (params.operation !== 'profile' && params.operation !== 'orders') throw new ReviewAuthError(404, 'NOT_FOUND', 'Not found.');
    const { customerId } = await authenticateReviewer(request);
    if (await reviewStore().increment('app-review:account-reads', 60) > 120) {
      throw new ReviewAuthError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.');
    }
    // No client-supplied customer ID, shop, GraphQL, or mutation is accepted.
    const data = params.operation === 'profile' ? await reviewProfile(customerId) : await reviewOrders(customerId);
    return respond.withNoStore(respond.ok(data, { correlationId: respond.getCorrelationId(request) }));
  } catch (error) { return reviewErrorResponse(error, request); }
}
