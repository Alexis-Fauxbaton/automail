// vitest.integration.config.ts
import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['app/lib/__tests__/integration/**/*.test.ts'],
    passWithNoTests: true,
    environment: 'node',
    globals: false,
    // Single fork, fully sequential: integration tests share the DB and must
    // not run in parallel — neither across files nor within a single file.
    // Without fileParallelism:false, Vitest would run test files concurrently
    // inside the single fork, causing beforeEach hooks from one file to
    // interleave with test bodies in another file and corrupt DB state.
    pool: 'forks',
    singleFork: true,
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
