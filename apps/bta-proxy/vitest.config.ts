import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./app"),
    },
  },
  test: {
    // Keep framework contexts in one module graph when testing Shopify's ESM provider.
    server: { deps: { inline: ["react-router", "@shopify/shopify-app-react-router"] } },
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.spec.ts"],
  },
});
