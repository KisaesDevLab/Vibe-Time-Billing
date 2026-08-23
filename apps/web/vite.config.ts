// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { fontScaleBootstrapScript } from '../../packages/ui/src/tokens';

// M0 — inject the canonical pre-paint font-scale bootstrap from the design
// system. index.html previously duplicated (and drifted from) the allowed
// steps, causing a visible zoom jump once React applied the real value.
function fontScaleBootstrap(): Plugin {
  return {
    name: 'vibe-font-scale-bootstrap',
    transformIndexHtml(html: string): string {
      return html.replace(
        /[ \t]*<!-- FONT_SCALE_BOOTSTRAP[^>]*-->/,
        `    <script>${fontScaleBootstrapScript}</script>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), fontScaleBootstrap()],
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
