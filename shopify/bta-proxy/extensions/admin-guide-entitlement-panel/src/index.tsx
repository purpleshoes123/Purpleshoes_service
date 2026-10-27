import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: import("@shopify/ui-extensions/admin.order-details.action.render").Api;

type Status = "loading" | "error" | "ready";

type EntitlementItem = {
  type: string;
  expiresAtKst: string | null;
  status: "ACTIVE" | "EXPIRED" | "NONE";
};

type LogItem = {
  id: string;
  status: string;
  monthsDelta: number;
  newExpiresAt: string | null;
  createdAt: string;
};

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const api = shopify;
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [items, setItems] = useState<EntitlementItem[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [detailUrl, setDetailUrl] = useState<string | null>(null);

  const orderId = useMemo(() => api.data?.selected?.[0]?.id, [api.data]);

  const decodeJwtPayload = (token: string) => {
    try {
      const [, payload] = token.split(".");
      if (!payload) return null;
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
      if (typeof atob !== "function") {
        return null;
      }
      const json = atob(padded);
      return JSON.parse(json) as { iss?: string; dest?: string };
    } catch {
      return null;
    }
  };

  useEffect(() => {
    if (!orderId) {
      setErrorMessage("Order context is missing.");
      setStatus("error");
      return;
    }

    (async () => {
      try {
        setStatus("loading");

        const orderQuery = `
          query OrderCustomer($id: ID!) {
            order(id: $id) {
              id
              name
              customer { id }
            }
          }
        `;

        const orderResponse = await fetch("shopify:admin/api/graphql.json", {
          method: "POST",
          body: JSON.stringify({ query: orderQuery, variables: { id: orderId } }),
        });
        const orderResult = await orderResponse.json() as {
          data?: { order?: { customer?: { id?: string } } };
          errors?: Array<{ message: string }>;
        };

        if (orderResult.errors && orderResult.errors.length > 0) {
          throw new Error(orderResult.errors.map((e) => e.message).join(", "));
        }

        const customerId = orderResult.data?.order?.customer?.id || null;
        if (!customerId) {
          setErrorMessage("Customer not found for this order.");
          setStatus("error");
          return;
        }

        const idToken = await api.auth.idToken();
        if (!idToken) {
          setErrorMessage("Failed to retrieve session token.");
          setStatus("error");
          return;
        }

        const payload = decodeJwtPayload(idToken);
        const dest = payload?.dest || payload?.iss;
        const shopDomain = dest ? new URL(dest).hostname : null;
        const storeHandle = shopDomain ? shopDomain.split(".")[0] : null;
        const appBase = storeHandle
          ? `https://admin.shopify.com/store/${storeHandle}/apps/bta-proxy`
          : null;

        if (!appBase) {
          setErrorMessage("Failed to resolve app URL.");
          setStatus("error");
          return;
        }

        const apiUrl = `${appBase}/app/api/guide-entitlements/customer/${encodeURIComponent(
          customerId
        )}`;
        setDetailUrl(
          `${appBase}/app/guide-entitlements-admin?customerId=${encodeURIComponent(
            customerId
          )}`
        );

        const response = await fetch(apiUrl, {
          headers: {
            Authorization: `Bearer ${idToken}`,
            "Content-Type": "application/json",
          },
        });

        const payloadJson = await response.json();
        if (!payloadJson?.ok) {
          throw new Error(payloadJson?.error?.message || "API error");
        }

        const data = payloadJson.data as {
          items: EntitlementItem[];
          logs: LogItem[];
        };

        setItems(data.items || []);
        setLogs(data.logs || []);
        setStatus("ready");
      } catch (error) {
        console.error("Guide entitlement panel failed", error);
        setErrorMessage("Failed to load guide entitlements.");
        setStatus("error");
      }
    })();
  }, [api, orderId]);

  return (
    <s-admin-action heading="Guide Extension Status">
      {detailUrl ? (
        <s-button slot="primary-action" href={detailUrl}>Open detail</s-button>
      ) : (
        <s-button slot="primary-action" disabled>Open detail</s-button>
      )}
      <s-button slot="secondary-actions" onClick={() => api.close()}>Close</s-button>
      <s-stack direction="block" gap="base">
        <s-text type="strong">Guide Extension Status</s-text>
        {status === "loading" ? (
          <s-spinner size="base" />
        ) : null}
        {status === "error" ? <s-text>{errorMessage}</s-text> : null}
        {status === "ready" ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">Entitlements</s-text>
            {items.length === 0 ? <s-text>No entitlements found.</s-text> : null}
            {items.map((item) => (
              <s-text key={item.type}>
                {item.type}: {item.expiresAtKst || "-"} ({item.status})
              </s-text>
            ))}
            <s-divider />
            <s-text type="strong">Recent Logs</s-text>
            {logs.length === 0 ? <s-text>No logs.</s-text> : null}
            {logs.map((log) => (
              <s-text key={log.id}>
                {log.status} | {log.monthsDelta} | {log.newExpiresAt || "-"} |{" "}
                {log.createdAt}
              </s-text>
            ))}
          </s-stack>
        ) : null}
      </s-stack>
    </s-admin-action>
  );
}
