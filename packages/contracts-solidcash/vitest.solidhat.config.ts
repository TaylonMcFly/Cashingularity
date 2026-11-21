import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'solidhat-bch-vm',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
