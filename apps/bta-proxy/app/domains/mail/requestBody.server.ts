import { storefrontMailRequestSchema, type StorefrontMailRequestInput } from "~/lib/validation";

function formDataToObject(formData: FormData) {
  const body: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      body[key] = value;
    }
  }

  return body;
}

export async function parseStorefrontMailRequestBody(
  request: Request,
): Promise<StorefrontMailRequestInput> {
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    const body = await request.json();
    return storefrontMailRequestSchema.parse(body);
  }

  if (
    !contentType ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    const formData = await request.formData();
    return storefrontMailRequestSchema.parse(formDataToObject(formData));
  }

  throw new TypeError("지원하지 않는 Content-Type입니다.");
}
