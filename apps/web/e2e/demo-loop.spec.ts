// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// End-to-end demo loop. Requires a freshly-seeded database (the Vance
// scenario lands automatically when DATABASE_URL points at an empty
// postgres + you've run `pnpm db:migrate && pnpm db:seed`). Run with:
//
//   STAFF_BASE_URL=http://localhost:5173 \
//   PORTAL_BASE_URL=http://localhost:5174 \
//   pnpm --filter @vibe/web test:e2e
//
// In dev you can fish the magic-link out of the API logs (see
// `sendMagicLink` console output). In CI we'd inject a console mail
// provider that exposes the link via an admin endpoint.

import { expect, test } from '@playwright/test';

const STAFF_EMAIL = process.env['DEMO_STAFF_EMAIL'] ?? `sarah${'@'}granitepeak.example.com`;

test.describe('staff demo loop', () => {
  test('login screen rejects garbage and accepts a real email', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const emailInput = page.getByLabel('Email');
    await emailInput.fill('not-an-email');
    await page.getByRole('button', { name: /Send sign-in link/i }).click();
    // Native HTML5 validation prevents submission for type=email
    await expect(emailInput).toBeFocused();

    await emailInput.fill(STAFF_EMAIL);
    await page.getByRole('button', { name: /Send sign-in link/i }).click();
    await expect(page.getByText(/sign-in code has been sent/i)).toBeVisible();
  });

  test('dashboard is gated when no session', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/auth\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
