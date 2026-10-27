import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

declare const shopify: import("@shopify/ui-extensions/purchase.thank-you.block.render").Api;

type Kind = "KIT" | "ONLY" | "TOUR" | "EXTENSION";

type Section = {
  kind: Kind;
  onlyTypes?: Array<"PDF" | "VIDEO">;
  extensionTypes?: Array<"PDF" | "VIDEO" | "BUNDLE">;
};

type SummaryResponse =
  | { ok: true; sections: Section[] }
  | { ok: false; error: string };

const APP_URL = "https://bta-proxy.kpurpleshoes.com";
const ACCOUNT_URL = "https://kpurpleshoes.com/account";
const TOUR_URL = "https://kpurpleshoes.com/pages/tours";
const EXTENSION_THANK_YOU_URL = "https://kpurpleshoes.com/pages/extention-thank";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const api = shopify;
  const confirmation = api.orderConfirmation.value;
  const [sections, setSections] = useState<Section[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const orderId = confirmation.order?.id;
    if (!orderId) return;

    let cancelled = false;
    (async () => {
      try {
        const token = await api.sessionToken.get();
        const response = await fetch(
          `${APP_URL}/public/post-purchase-summary/${encodeURIComponent(orderId)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const payload = (await response.json()) as SummaryResponse;
        if (cancelled) return;
        if (!response.ok) {
          setFailed(true);
          return;
        }
        if (payload.ok === false) {
          setFailed(true);
          return;
        }
        setSections(payload.sections);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, confirmation.order?.id]);

  // The Shopify Thank you page and confirmation email remain usable even when
  // this optional enrichment request fails. Avoid showing customers a warning
  // banner for that non-blocking failure.
  if (failed) return null;
  if (!sections || sections.length === 0) return null;

  return (
    <s-stack gap="base" direction="block">
      {sections.map((section, index) => (
        <s-stack gap="small" direction="block" key={section.kind}>
          {index > 0 ? <s-divider /> : null}
          <ConfirmationCard section={section} />
        </s-stack>
      ))}
    </s-stack>
  );
}

function ConfirmationCard({ section }: { section: Section }) {
  if (section.kind === "KIT") {
    return (
      <s-stack gap="small" direction="block">
        <s-text type="strong">Your Korea Guide Kit is ready</s-text>
        <s-text>Your Guidebook, Video Guide, and map access are available in My Page. Your unlimited 15% Tour benefit has also been added.</s-text>
        <s-link href={ACCOUNT_URL}>Open My Page and Viewer</s-link>
      </s-stack>
    );
  }

  if (section.kind === "ONLY") {
    const label = section.onlyTypes?.join(" + ") || "Guide";
    return (
      <s-stack gap="small" direction="block">
        <s-text type="strong">Your {label} purchase is ready</s-text>
        <s-text>Only the guide content included in this order is available in My Page. Add the Korea Guide Kit there when you are ready for the full bundle.</s-text>
        <s-link href={ACCOUNT_URL}>Open My Page</s-link>
      </s-stack>
    );
  }

  if (section.kind === "TOUR") {
    return (
      <s-stack gap="small" direction="block">
        <s-text type="strong">Your Tour is confirmed</s-text>
        <s-text>Your reservation details and confirmation have been sent by email. You can also review your trip information from My Page.</s-text>
        <s-link href={ACCOUNT_URL}>Open My Page</s-link>
        <s-link href={TOUR_URL}>Explore Tours</s-link>
      </s-stack>
    );
  }

  const types = section.extensionTypes?.join(" + ") || "Guide";
  return (
    <s-stack gap="small" direction="block">
      <s-text type="strong">Your {types} access extension is complete</s-text>
      <s-text>Your new expiration date is available in My Page after the payment update is processed.</s-text>
      <s-link href={EXTENSION_THANK_YOU_URL}>View updated access details</s-link>
      <s-link href={ACCOUNT_URL}>Open My Page</s-link>
    </s-stack>
  );
}
