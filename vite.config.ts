/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // RowLens processes user files entirely in the browser; nothing is proxied
  // to a server, so there is deliberately no dev-server proxy configuration.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
    // fake-indexeddb makes 5k-row App tests multi-second; keep headroom.
    testTimeout: 20_000,
  },
});
