import { createHash } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const SECRET_ID = "purpleshoes/prod/meta-lead";
const META_API_VERSION = "v25.0";

type MetaLeadCredentials = { pixelId: string; accessToken: string };

async function readCredentials(): Promise<MetaLeadCredentials> {
  const client = new SecretsManagerClient({ region: "ap-northeast-2" });
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    const value = JSON.parse(response.SecretString || "null");
    if (
      !/^\d{8,25}$/.test(value?.pixelId) ||
      typeof value?.accessToken !== "string" ||
      value.accessToken.length < 20
    ) {
      throw new Error("Invalid Meta Lead configuration");
    }
    return { pixelId: value.pixelId, accessToken: value.accessToken };
  } finally {
    client.destroy();
  }
}

export async function sendSqueezeLead(params: {
  requestId: string;
  email: string;
  fbc?: string;
  fbp?: string;
}): Promise<void> {
  const { pixelId, accessToken } = await readCredentials();
  const em = createHash("sha256").update(params.email.trim().toLowerCase(), "utf8").digest("hex");
  const userData: Record<string, unknown> = { em: [em] };
  // Browser IDs from the existing Shopify/Meta integration improve matching
  // without installing another pixel. Reject arbitrary client strings.
  if (params.fbc && /^fb\.1\.\d{10,16}\.[A-Za-z0-9_-]{1,200}$/.test(params.fbc)) {
    userData.fbc = params.fbc;
  }
  if (params.fbp && /^fb\.1\.\d{10,16}\.[A-Za-z0-9_-]{1,200}$/.test(params.fbp)) {
    userData.fbp = params.fbp;
  }
  const response = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: accessToken,
      data: [
        {
          event_name: "Lead",
          event_time: Math.floor(Date.now() / 1000),
          event_id: params.requestId,
          action_source: "website",
          event_source_url: "https://kpurpleshoes.com/pages/squeezthank",
          user_data: userData,
          custom_data: { lead_type: "starter_kit" },
        },
      ],
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    throw new Error(`Meta Lead delivery failed (${response.status})`);
  }
  const result = (await response.json()) as { events_received?: number };
  if (result.events_received !== 1) {
    throw new Error("Meta Lead was not accepted");
  }
}
