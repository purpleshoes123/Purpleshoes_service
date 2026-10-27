import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  // CloudFront/ALB forwards the internal origin hostname. Trust only our
  // public embedded-app host; Shopify authentication remains mandatory.
  allowedActionOrigins: ["bta-proxy.kpurpleshoes.com"],
} satisfies Config;
