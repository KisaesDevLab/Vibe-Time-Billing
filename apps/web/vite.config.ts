// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5195,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Distinct name for the entry chunk so the bundle-size budget guard
        // (ops/scripts/check-bundle-size.mjs) measures the true entry and is
        // not confused by route chunks that also hash to `index-*` (e.g. the
        // lazy-loaded pages/admin/index module). Route/vendor chunks keep the
        // default `[name]-[hash]` naming.
        entryFileNames: 'assets/entry-[hash].js',
      },
    },
  },
});
