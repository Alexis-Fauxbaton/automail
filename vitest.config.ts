import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    exclude: ["app/lib/__tests__/integration/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["app/lib/support/**/*.ts"],
      exclude: [
        "app/lib/support/**/__tests__/**",
        "app/lib/support/**/*.test.ts",
        "app/lib/support/llm-draft.ts",
        "app/lib/support/llm-parser.ts",
        "app/lib/support/settings.ts",
        "app/lib/support/thread-state.ts",
        "app/lib/support/crawl/**",
        "app/lib/support/tracking/tracking-agent.ts",
        "app/lib/support/tracking/adapters/**",
      ],
      reporter: ["text", "html"],
    },
  },
});
