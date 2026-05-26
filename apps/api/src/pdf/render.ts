// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Puppeteer HTML→PDF renderer. Q18: PDFs via headless Chrome.
//
// P14 — when PDF_SIDECAR_URL is set, requests are POSTed to an
// external Puppeteer sidecar (Alpine + Chromium, separate container)
// so the API container doesn't have to bundle ~300MB of Chrome. Falls
// back to in-process Puppeteer when the env var is unset — that keeps
// dev-loop quick and matches the appliance-default Dockerfile which
// still ships Chrome.
//
// Dev fallback: if puppeteer isn't installed AND no sidecar is
// configured, callers catch the import error and serve the HTML
// response directly.

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

export interface PdfRenderOptions {
  // Override the global sidecar URL (test seam). Production code reads
  // process.env['PDF_SIDECAR_URL'].
  sidecarUrl?: string;
  // Test seam for the network edge.
  fetchImpl?: typeof fetch;
  // Render timeout in ms. Default 30s per addendum P14 spec.
  timeoutMs?: number;
}

async function renderViaSidecar(
  html: string,
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html,
        options: {
          format: 'Letter',
          printBackground: true,
          margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`pdf_sidecar_failed: ${res.status}`);
    }
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } finally {
    clearTimeout(timer);
  }
}

export async function renderHtmlToPdf(html: string, opts: PdfRenderOptions = {}): Promise<Buffer> {
  const sidecarUrl = opts.sidecarUrl ?? process.env['PDF_SIDECAR_URL'];
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (sidecarUrl) {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    return renderViaSidecar(html, sidecarUrl, fetchImpl, timeoutMs);
  }
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
