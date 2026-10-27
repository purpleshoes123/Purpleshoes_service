import { normalizeCode } from "./normalize";
import { clearGuide50Fields, clearExtra10Fields } from "./state";
import { markRevoked } from "./revoked";

export async function handleInvalidCode(
  customerId: string,
  codeRaw: string
): Promise<void> {
  const code = normalizeCode(codeRaw);
  if (!code) return;

  await markRevoked(customerId, code);

  if (code.startsWith("GUIDE50")) {
    await clearGuide50Fields(customerId);
  }

  if (code.startsWith("EXTRA10")) {
    await clearExtra10Fields(customerId);
  }
}
