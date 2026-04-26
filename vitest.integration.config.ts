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
    // Single fork: integration tests share the DB and must not run in parallel
    pool: 'forks',
    singleFork: true,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
