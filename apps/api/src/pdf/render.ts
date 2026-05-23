// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Puppeteer HTML→PDF renderer. Q18: PDFs via headless Chrome.
// PUPPETEER_EXECUTABLE_PATH is set in the production Dockerfile so
// Puppeteer uses the system Chromium and we skip the bundled download.
//
// Dev fallback: if puppeteer isn't installed, callers catch the import
// error and serve the HTML response directly.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBrowser = any;

let cached: AnyBrowser | null = null;

async function getBrowser(): Promise<AnyBrowser> {
  if (cached) return cached;
  const puppeteer = await import('puppeteer');
  cached = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] || undefined,
  });
  return cached;
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function shutdownPdfRenderer(): Promise<void> {
  if (cached) {
    await cached.close().catch(() => undefined);
    cached = null;
  }
}
