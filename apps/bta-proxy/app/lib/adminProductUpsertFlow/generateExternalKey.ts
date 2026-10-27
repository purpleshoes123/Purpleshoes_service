import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { fetchProductIdByExternalKey } from "~/lib/adminProductUpsertFlow/fetchProductIdByExternalKey";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
}

export async function generateExternalKey(
  adminClient: AdminApiContext,
  maxRetries = 20
): Promise<string> {
  const baseKey = `travel_${formatTimestamp(new Date())}`;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const candidate = attempt === 1 ? baseKey : `${baseKey}-${attempt}`;
    const existing = await fetchProductIdByExternalKey(adminClient, candidate);
    if (!existing) {
      return candidate;
    }
  }

  throw new Error(
    `external_key 생성 실패: ${maxRetries}회 중복 (base=${baseKey})`
  );
}
