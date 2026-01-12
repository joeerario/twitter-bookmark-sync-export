import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
});

export const unitConfig = defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.integration.test.ts'],
  },
});

export const integrationConfig = defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
  },
});
