import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{api,worker,dashboard,packages}/**/*.test.ts'],
    environment: 'node',
  },
});
