import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Rapier's wasm init is slow on the first import.
    testTimeout: 20000,
  },
});
