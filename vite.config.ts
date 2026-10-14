/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
