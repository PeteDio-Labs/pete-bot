import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/db/remediations.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
