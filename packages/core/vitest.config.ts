// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Phase 12 implements allocation methods; the test file ships with the
    // bootstrap (TDD) but the suite is excluded until the implementation
    // lands. Re-enable by removing the entry below.
    exclude: ['**/node_modules/**', '**/dist/**', '**/adjustment-allocation.test.ts'],
  },
});
