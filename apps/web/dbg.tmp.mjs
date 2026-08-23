import { chromium, devices } from '@playwright/test';
const b = await chromium.launch();
const ctx = await b.newContext({ ...devices['iPhone 12'], baseURL: process.env.STAFF_BASE_URL });
await ctx.addCookies([{ name: '__vibe_app_session', value: process.env.STAFF_SESSION_COOKIE, url: process.env.STAFF_BASE_URL }]);
const page = await ctx.newPage();
for (const route of ['/', '/time', '/engagements', '/intake', '/reports', '/ar', '/audit', '/admin/users']) {
  await page.goto(process.env.STAFF_BASE_URL + route, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const culprits = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > cw - 20 && r.right > cw + 2;
    });
    // leaf-most: wide elements none of whose children are as wide
    const leaves = wide.filter((el) => ![...el.children].some((c) => {
      const r = c.getBoundingClientRect();
      return r.width > cw - 20 && r.right > cw + 2;
    }));
    return leaves.slice(0, 5).map((el) => {
      const r = el.getBoundingClientRect();
      const html = el.cloneNode(false).outerHTML.slice(0, 200);
      const text = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 80);
      return `w=${Math.round(r.width)} ${html} :: "${text}"`;
    });
  });
  console.log('\n==', route);
  for (const c of culprits) console.log('  ', c);
}
await b.close();
