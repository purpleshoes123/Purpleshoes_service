import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "~/db.server";
import {
  isValidMailUnsubscribeSignature,
  suppressMailRecipient,
  syncShopifyEmailMarketingUnsubscribe,
} from "~/domains/mail/unsubscribe.server.ts";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "text/html; charset=utf-8",
  "X-Robots-Tag": "noindex, nofollow",
};

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(params: {
  title: string;
  message: string;
  form?: { sendRequestId: string; signature: string };
}) {
  const action = params.form
    ? `<form method="post"><input type="hidden" name="rid" value="${escapeHtml(
        params.form.sendRequestId,
      )}"><input type="hidden" name="sig" value="${escapeHtml(
        params.form.signature,
      )}"><button type="submit">Confirm unsubscribe</button></form>`
    : `<a class="button" href="https://kpurpleshoes.com/">Continue to Purple Shoes</a>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(params.title)} | Purple Shoes</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f3ff;color:#191124;font:16px/1.6 Arial,Helvetica,sans-serif}
      main{box-sizing:border-box;width:min(100% - 32px,560px);padding:44px 34px;border-radius:24px;background:#fff;box-shadow:0 24px 70px rgba(53,16,127,.16);text-align:center}
      .eyebrow{margin:0 0 14px;color:#5b2bd8;font-weight:800;letter-spacing:.08em;font-size:12px;text-transform:uppercase}
      h1{margin:0 0 16px;font-size:30px;line-height:1.2}.message{margin:0 0 28px;color:#4b435f}
      button,.button{display:inline-block;border:0;border-radius:999px;padding:14px 24px;background:#5b2bd8;color:#fff;font:700 16px Arial,Helvetica,sans-serif;text-decoration:none;cursor:pointer}
      button:hover,.button:hover{background:#35107f}
    </style>
  </head>
  <body><main><p class="eyebrow">Purple Shoes</p><h1>${escapeHtml(
    params.title,
  )}</h1><p class="message">${escapeHtml(params.message)}</p>${action}</main></body>
</html>`;
}

async function getVerifiedSendRequest(params: {
  sendRequestId: string | null;
  signature: string | null;
}) {
  const sendRequestId = params.sendRequestId?.trim() || "";
  if (!sendRequestId || !params.signature) {
    return null;
  }

  const sendRequest = await db.mailSendRequest.findUnique({
    where: { id: sendRequestId },
    select: {
      id: true,
      shopDomain: true,
      recipientEmail: true,
    },
  });

  if (
    !sendRequest ||
    !isValidMailUnsubscribeSignature({
      shopDomain: sendRequest.shopDomain,
      sendRequestId: sendRequest.id,
      signature: params.signature,
    })
  ) {
    return null;
  }

  return sendRequest;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const sendRequest = await getVerifiedSendRequest({
    sendRequestId: url.searchParams.get("rid"),
    signature: url.searchParams.get("sig"),
  });

  if (!sendRequest) {
    return new Response(
      page({
        title: "This unsubscribe link is invalid",
        message: "Please use the latest unsubscribe link from a Purple Shoes email.",
      }),
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  return new Response(
    page({
      title: "Unsubscribe from Purple Shoes emails?",
      message: "Confirming this will stop future Purple Shoes marketing emails to this address.",
      form: {
        sendRequestId: sendRequest.id,
        signature: url.searchParams.get("sig") || "",
      },
    }),
    { headers: RESPONSE_HEADERS },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const sendRequest = await getVerifiedSendRequest({
    sendRequestId: String(formData.get("rid") || ""),
    signature: String(formData.get("sig") || ""),
  });

  if (!sendRequest) {
    return new Response(
      page({
        title: "This unsubscribe link is invalid",
        message: "Please use the latest unsubscribe link from a Purple Shoes email.",
      }),
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  await suppressMailRecipient(db, {
    shopDomain: sendRequest.shopDomain,
    recipientEmail: sendRequest.recipientEmail,
    sourceSendRequestId: sendRequest.id,
  });

  try {
    await syncShopifyEmailMarketingUnsubscribe({
      shopDomain: sendRequest.shopDomain,
      recipientEmail: sendRequest.recipientEmail,
    });
  } catch (error) {
    // BTA suppression is already recorded. Shopify sync must not make an
    // opt-out fail for a non-member or during a transient Admin API outage.
    console.warn(
      JSON.stringify({
        message: "Shopify marketing consent sync failed after BTA unsubscribe",
        sendRequestId: sendRequest.id,
      }),
    );
  }

  return new Response(
    page({
      title: "You’re unsubscribed",
      message: "You will no longer receive Purple Shoes marketing emails.",
    }),
    { headers: RESPONSE_HEADERS },
  );
};
