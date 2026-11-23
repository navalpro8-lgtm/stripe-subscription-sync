import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/support/global-setup.ts'],
    // All test files share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
