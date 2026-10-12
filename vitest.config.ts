import { defineConfig } from 'vitest/config';

// Offline unit and service tests; no live provider requests.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
