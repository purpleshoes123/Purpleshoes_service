import { authenticate } from "~/shopify.server.ts";

// Cache only for this Request object; never share an authenticated session across requests.
const checks = new WeakMap<Request, Promise<unknown>>();

export async function requireGkvAdmin(request: Request): Promise<void> {
  let check = checks.get(request);
  if (!check) {
    check = authenticate.admin(request);
    checks.set(request, check);
  }
  await check;
}
