import { useEffect, useState } from "react";
import { json } from "~/lib/httpJson";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useLocation, useNavigate } from "react-router";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Page,
  RadioButton,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "~/shopify.server";
import { withEmbeddedSearch } from "~/lib/gkv/embeddedPath";

type LoaderData = {
  ok: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json<LoaderData>({ ok: true });
};

export default function AdminReviewCreatePage() {
  useLoaderData<LoaderData>();
  const app = useAppBridge();
  const createFetcher = useFetcher<any>();
  const navigate = useNavigate();
  const location = useLocation();

  const [productId, setProductId] = useState("");
  const [productTitle, setProductTitle] = useState("");
  const [placement, setPlacement] = useState<"homepage" | "product">("product");
  const [body, setBody] = useState("");
  const [authorDisplayName, setAuthorDisplayName] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);

  useEffect(() => {
    const payload = createFetcher.data as any;
    if (!payload) return;
    if (payload.ok) {
      setSuccessMessage("Admin review created.");
      setErrorMessage(null);
      setBody("");
      return;
    }
    if (payload.error?.message) {
      setSuccessMessage(null);
      setErrorMessage(payload.error.message);
    }
  }, [createFetcher.data]);

  const handlePickProduct = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsPicking(true);
    try {
      await app.ready;
      const selection = await app.resourcePicker({
        type: "product",
        action: "select",
        multiple: false,
      });
      const picked = selection
        ? Array.isArray(selection)
          ? selection
          : selection.selection
        : [];
      const product = picked[0];
      if (product) {
        setProductId(product.id);
        setProductTitle(product.title || product.id);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to select product."
      );
    } finally {
      setIsPicking(false);
    }
  };

  const canSubmit =
    body.trim().length >= 20 &&
    (placement === "homepage" || Boolean(productId));

  return (
    <Page>
      <TitleBar title="Create Admin Review" />
      <BlockStack gap="500">
        {errorMessage ? (
          <Banner tone="critical" onDismiss={() => setErrorMessage(null)}>
            {errorMessage}
          </Banner>
        ) : null}
        {successMessage ? (
          <Banner tone="success" onDismiss={() => setSuccessMessage(null)}>
            {successMessage}
          </Banner>
        ) : null}

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Create Admin Review
              </Text>
              <Button onClick={() => navigate(withEmbeddedSearch("/app/reviews", location.search))} variant="secondary">
                Back to Reviews
              </Button>
            </InlineStack>

            <InlineStack gap="200" blockAlign="center">
              <RadioButton
                label="Product review — show only on the selected product page"
                checked={placement === "product"}
                id="review-placement-product"
                name="review-placement"
                onChange={() => setPlacement("product")}
              />
              <RadioButton
                label="Homepage review — show only on the homepage"
                checked={placement === "homepage"}
                id="review-placement-homepage"
                name="review-placement"
                onChange={() => setPlacement("homepage")}
              />
            </InlineStack>
            {placement === "product" ? (
              <InlineStack gap="200" blockAlign="center">
                <Button onClick={handlePickProduct} loading={isPicking}>
                  Select product
                </Button>
                <Text as="span" variant="bodySm" tone="subdued">
                  {productTitle ? `Selected product: ${productTitle}` : "Select a product."}
                </Text>
              </InlineStack>
            ) : (
              <Text as="p" variant="bodySm" tone="subdued">
                This review will be visible only in the homepage review section.
              </Text>
            )}
            <TextField
              label="Body"
              value={body}
              onChange={setBody}
              multiline={4}
              autoComplete="off"
              helpText="Enter at least 20 characters."
            />
            <TextField
              label="Author Display Name"
              value={authorDisplayName}
              onChange={setAuthorDisplayName}
              placeholder="Operations"
              autoComplete="off"
            />
            <InlineStack gap="200">
              <Button
                variant="primary"
                loading={createFetcher.state !== "idle"}
                disabled={!canSubmit}
                onClick={() => {
                  const formData = new FormData();
                  formData.set("placement", placement);
                  formData.set("productId", productId);
                  formData.set("body", body);
                  if (authorDisplayName.trim()) {
                    formData.set("authorDisplayName", authorDisplayName.trim());
                  }
                  createFetcher.submit(formData, {
                    method: "post",
                    action: withEmbeddedSearch("/app/reviews/admin/create", location.search),
                  });
                }}
              >
                Create
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
