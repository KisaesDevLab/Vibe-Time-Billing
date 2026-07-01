// SPDX-License-Identifier: Elastic-2.0
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

// SSRF guard for in-process Chrome. Templates are HTML-escaped, so tag
// injection shouldn't be possible — but if a firm-set URL (e.g. a logo)
// or a future template ever points at an internal address, Chrome would
// happily fetch it (cloud metadata, localhost services, LAN hosts). Block
// requests to loopback / link-local / RFC-1918 / unique-local targets and
// any non-http(s) scheme other than inlined data: URIs.
function isBlockedPdfHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / RFC1918
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function guardPageRequests(page: any): Promise<void> {
  await page.setRequestInterception(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page.on('request', (intercepted: any) => {
    const url: string = intercepted.url();
    if (url.startsWith('data:') || url.startsWith('about:')) {
      void intercepted.continue();
      return;
    }
    try {
      const u = new URL(url);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !isBlockedPdfHost(u.hostname)) {
        void intercepted.continue();
        return;
      }
    } catch {
      /* fall through to abort */
    }
    void intercepted.abort();
  });
}

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
  // Override the default 0.5in page margins (Chromium honors the page.pdf
  // `margin` option, NOT the CSS `@page { margin }` rule). Per-side; omit a
  // side to keep the 0.5in default for it.
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
}

const DEFAULT_MARGIN = { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' };

// The options object handed to page.pdf() (and the sidecar). Default =
// Letter + 0.5in margins (unchanged for every existing caller); a caller
// can override the margins (e.g. mail-merge letters use 1in). Exported for tests.
export function pdfPageOptions(opts: PdfRenderOptions): Record<string, unknown> {
  return {
    format: 'Letter',
    printBackground: true,
    margin: { ...DEFAULT_MARGIN, ...opts.margin },
  };
}

async function renderViaSidecar(
  html: string,
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  pageOptions: Record<string, unknown>,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, options: pageOptions }),
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
  const pageOptions = pdfPageOptions(opts);
  if (sidecarUrl) {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    return renderViaSidecar(html, sidecarUrl, fetchImpl, timeoutMs, pageOptions);
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await guardPageRequests(page);
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf(pageOptions);
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
