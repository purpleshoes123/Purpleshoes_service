import { isIP } from "node:net";

/** Only enable after the origin is restricted to our CloudFront -> ALB path.
 * Nginx must PRESERVE the ALB XFF, not append another hop. CloudFront appends
 * the viewer and ALB appends the edge IP; viewer-supplied prefixes are untrusted.
 */
export function getRateLimitClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (process.env.DEPLOYMENT_MODE?.trim() === "multi-node") {
    if (process.env.TRUSTED_PROXY_MODE !== "cloudfront-alb") {
      throw new Error("Verified proxy topology is required");
    }
    const hops = forwarded?.split(",").map(value => value.trim()) ?? [];
    const viewer = hops.at(-2);
    const edge = hops.at(-1);
    if (!viewer || !edge || !isIP(viewer) || !isIP(edge)) {
      throw new Error("Invalid trusted proxy chain");
    }
    // Canonicalize equivalent IPv6 representations before deriving a counter key.
    return isIP(viewer) === 6 ? new URL(`http://[${viewer}]/`).hostname : viewer;
  }
  // Preserve the existing single-server behavior until its proxy is migrated.
  return forwarded?.split(",")[0]?.trim()
    || request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || new URL(request.url).hostname;
}
