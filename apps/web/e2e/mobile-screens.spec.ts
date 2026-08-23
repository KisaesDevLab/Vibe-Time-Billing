// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// M0 — mobile acceptance sweep. Two jobs:
//
//   1. `iphone` project (390×844): every listed page must not overflow
//      the viewport horizontally, and a full-page screenshot lands in
//      e2e/__screenshots__/mobile/ as a reviewable artifact.
//   2. `desktop-baseline` project (1440×900): pixel baselines for a few
//      representative pages prove the responsive work didn't move
//      desktop pixels (maxDiffPixelRatio 0.001).
//
// Auth: paste a live staff session cookie via STAFF_SESSION_COOKIE
// (value of __vibe_app_session from a signed-in browser). All tests
// skip when it's unset, so plain `pnpm test:e2e` stays green.
//
//   STAFF_BASE_URL=https://practice.vcpa.app \
//   STAFF_SESSION_COOKIE=<cookie value> \
//   pnpm exec playwright test e2e/mobile-screens.spec.ts --project=iphone

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

const COOKIE = process.env['STAFF_SESSION_COOKIE'];

/** Route → screenshot slug. Keep desk pages in — they only need the
 *  no-overflow assertion (scroll is fine, sideways page-pan is not). */
const PAGES: Array<[route: string, slug: string]> = [
  // Phase 1-2: deep mobile UX
  ['/', 'dashboard'],
  ['/time', 'time-entry'],
  ['/tasks', 'tasks'],
  ['/messages', 'messages'],
  ['/notifications', 'notifications'],
  ['/clients', 'clients'],
  ['/invoices', 'invoices'],
  ['/engagements', 'engagements'],
  ['/approvals', 'approvals'],
  ['/requests', 'requests'],
  // Sweep: merely-usable pages — the no-overflow assertion is the bar
  ['/people', 'people'],
  ['/payments', 'payments'],
  ['/appointments', 'appointments'],
  ['/calendar/mine', 'my-calendar'],
  ['/alerts', 'alerts'],
  ['/intake', 'intake'],
  ['/signatures', 'signatures'],
  ['/proposals', 'proposals'],
  ['/retainers', 'retainers'],
  ['/filer', 'filer'],
  ['/help', 'help'],
  ['/account', 'account'],
  // Desk pages: scroll-only, still must not pan sideways
  ['/reports', 'reports'],
  ['/wip', 'wip'],
  ['/ar', 'ar'],
  ['/audit', 'audit'],
  ['/billing/batches', 'billing'],
  ['/admin/users', 'admin-users'],
];

/** Representative pages for the desktop pixel baseline. */
const DESKTOP_BASELINE: Array<[route: string, slug: string]> = [
  ['/', 'dashboard'],
  ['/clients', 'clients'],
  ['/time', 'time-entry'],
];

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!COOKIE, 'STAFF_SESSION_COOKIE not set — mobile sweep skipped');
  await context.addCookies([{ name: '__vibe_app_session', value: COOKIE!, url: baseURL! }]);
});

test.describe('phone: no horizontal overflow + screenshots', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'iphone', 'iphone project only');
  });

  for (const [route, slug] of PAGES) {
    test(`${slug} fits 390px`, async ({ page }) => {
      await page.goto(route);
      // Not 'networkidle': the app polls (timers, unread counts), so that
      // state never arrives. Load + a short settle is deterministic enough.
      await page.waitForLoadState('load');
      await page.waitForTimeout(2500);
      // Signed-out redirect means the cookie is stale — fail loudly.
      expect(page.url()).not.toContain('/auth/login');
      const overflow = await page.evaluate(() => {
        const el = document.documentElement;
        return el.scrollWidth - el.clientWidth;
      });
      expect(overflow, `${route} horizontal overflow`).toBeLessThanOrEqual(1);
      const file = join(
        test.info().project.testDir ?? '.',
        '__screenshots__',
        'mobile',
        `${slug}.png`,
      );
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: true });
    });
  }

  test('nav drawer opens from the hamburger', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeVisible();
  });
});

test.describe('desktop baseline (1440×900) — pixels must not move', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'desktop-baseline', 'desktop-baseline project only');
  });

  for (const [route, slug] of DESKTOP_BASELINE) {
    test(`${slug} desktop baseline`, async ({ page }) => {
      await page.goto(route);
      await page.waitForLoadState('load');
      await page.waitForTimeout(2500);
      expect(page.url()).not.toContain('/auth/login');
      await expect(page).toHaveScreenshot(`${slug}-desktop.png`, {
        fullPage: false,
        maxDiffPixelRatio: 0.001,
        // Timers/dates churn — mask nothing yet; individual baselines can
        // add masks when a page proves flaky.
      });
    });
  }
});
