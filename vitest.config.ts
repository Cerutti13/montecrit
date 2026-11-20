import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tools/test/**/*.test.ts', 'tools/import-srd/test/**/*.test.ts'],
  },
});
