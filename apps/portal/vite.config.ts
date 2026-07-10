// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // Installable PWA. injectManifest mode: we ship a hand-written service
    // worker (src/sw.ts) and the plugin only injects the precache manifest
    // (self.__WB_MANIFEST) of hashed build assets. We serve our own
    // firm-branded manifest from the API, so the plugin emits none
    // (manifest: false) and does not auto-register (we register in pwa.ts).
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5196,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
