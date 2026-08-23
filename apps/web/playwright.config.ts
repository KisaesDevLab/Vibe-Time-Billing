// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env['STAFF_BASE_URL'] ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // M0 — phone project for the mobile-responsive sweep. Chromium build
    // of the iPhone 12 profile (390×844, DPR 3, touch, mobile UA).
    { name: 'iphone', use: { ...devices['iPhone 12'], browserName: 'chromium' } },
    // Desktop-regression baseline viewport for toHaveScreenshot diffs.
    {
      name: 'desktop-baseline',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
