import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    pool: "vmForks",
    environment: "node",
    include: ["app/**/*.test.ts"],
    exclude: ["app/lib/__tests__/integration/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["app/lib/support/**/*.ts"],
      // Each exclusion is followed by a one-line rationale so future
      // contributors don't accidentally trust 100% coverage on these files.
      exclude: [
        "app/lib/support/**/__tests__/**",                    // test files themselves
        "app/lib/support/**/*.test.ts",                       // colocated unit tests
        "app/lib/support/llm-draft.ts",                       // OpenAI calls; template fallback exercised in pipeline.test.ts
        "app/lib/support/llm-parser.ts",                      // OpenAI calls; regex fallback exercised in pipeline.test.ts
        "app/lib/support/settings.ts",                        // DB-backed; covered by integration tests
        "app/lib/support/thread-state.ts",                    // covered by thread-state.test.ts via integration paths
        "app/lib/support/crawl/**",                           // network-bound carrier crawler; integration-only
        "app/lib/support/tracking/tracking-agent.ts",         // OpenAI + scrape; integration-only
        "app/lib/support/tracking/adapters/**",               // 17track adapter; covered via crawl integration tests
      ],
      reporter: ["text", "html"],
    },
  },
});
