// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
