// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// ProtectedPdfViewer — renders a PDF to <canvas> via pdf.js (never the
// native browser viewer), so there's no download/print toolbar. We also
// suppress the right-click menu and hide the canvases from print output.
// Used by the client portal tax-return viewer and the 3rd-party
// recipient page. Note: this stops casual save/print, not a determined
// screenshot.
//
// Pages render LAZILY: each page starts as a fixed-aspect placeholder and
// gets its canvas only when scrolled near; canvases far off-screen are
// released again. Eager rendering held 40+ full-size canvases alive at
// once (~hundreds of MB), which blanked pages or reloaded the tab on iOS
// Safari — the exact device tax-return clients read on.

import { useEffect, useRef, useState } from 'react';

import { Button, tokens, useIsNarrow } from '@vibe/ui';

// Lazy pdf.js loader (worker wired once). Same pattern as the staff
// FieldEditor so the worker asset is bundled by Vite.
const importPdfjs = () => import('pdfjs-dist');
let pdfjsPromise: ReturnType<typeof importPdfjs> | null = null;
function loadPdfjs(): ReturnType<typeof importPdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await importPdfjs();
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<unknown> };
}
interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  destroy(): Promise<unknown>;
}

export function ProtectedPdfViewer({
  url,
  canDownload,
  filename,
  downloadUrl,
}: {
  url: string;
  canDownload: boolean;
  filename: string;
  /** 0150 — server-enforced download endpoint when it differs from the
   *  inline-view URL (gated file shares). Defaults to `url`. */
  downloadUrl?: string;
}): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const narrow = useIsNarrow();

  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    let pdf: PdfDocLike | null = null;
    const wrappers: HTMLDivElement[] = []; // index = pageNumber - 1
    const canvases = new Map<number, HTMLCanvasElement>();
    const ratios = new Map<number, number>(); // pageNumber -> height/width
    const wanted = new Set<number>();
    const queue: number[] = [];
    let pumping = false;
    let defaultRatio = 11 / 8.5;

    function placeholder(w: HTMLDivElement, n: number): void {
      const r = ratios.get(n) ?? defaultRatio;
      w.style.aspectRatio = `1 / ${r}`;
      w.replaceChildren();
    }

    function release(n: number): void {
      const c = canvases.get(n);
      if (!c) return;
      canvases.delete(n);
      const w = wrappers[n - 1];
      if (w) placeholder(w, n);
      // Free the backing store immediately (Safari holds it otherwise).
      c.width = 0;
      c.height = 0;
    }

    async function renderPage(n: number): Promise<void> {
      if (!pdf || cancelled || canvases.has(n)) return;
      const page = await pdf.getPage(n);
      if (cancelled || !wanted.has(n)) return;
      const base = page.getViewport({ scale: 1 });
      const host = hostRef.current;
      // Cap the raster to what this screen can actually show — a 3x phone
      // needs ~1170px, a laptop 1100; never more than 2x the PDF's own size.
      const targetW = Math.min(
        1100,
        Math.max(640, (host?.clientWidth ?? 800) * (window.devicePixelRatio || 1)),
      );
      const scale = Math.min(2, targetW / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.style.display = 'block';
      canvas.style.boxShadow = '0 1px 6px rgba(0,0,0,0.3)';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (cancelled || !wanted.has(n)) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      ratios.set(n, viewport.height / viewport.width);
      const w = wrappers[n - 1];
      if (w) {
        w.style.aspectRatio = '';
        w.replaceChildren(canvas);
        canvases.set(n, canvas);
      }
    }

    function pump(): void {
      if (pumping) return;
      pumping = true;
      void (async () => {
        while (queue.length > 0 && !cancelled) {
          const n = queue.shift()!;
          if (!wanted.has(n) || canvases.has(n)) continue;
          try {
            await renderPage(n);
          } catch {
            // Skip a page that fails to rasterize; the rest still render.
          }
        }
        pumping = false;
      })();
    }

    void (async () => {
      setStatus('loading');
      setErrMsg(null);
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (cancelled) return;
        if (!res.ok) {
          let msg = `status ${res.status}`;
          try {
            const b = (await res.json()) as { error?: string };
            if (b?.error) msg = b.error;
          } catch {
            /* non-JSON body */
          }
          setErrMsg(msg);
          setStatus('error');
          return;
        }
        const data = new Uint8Array(await res.arrayBuffer());
        const pdfjs = await loadPdfjs();
        pdf = (await pdfjs.getDocument({ data }).promise) as unknown as PdfDocLike;
        if (cancelled) return;
        const host = hostRef.current;
        if (!host) return;
        const first = await pdf.getPage(1);
        const fv = first.getViewport({ scale: 1 });
        defaultRatio = fv.height / fv.width;

        host.innerHTML = '';
        observer = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              const n = Number((e.target as HTMLElement).dataset['page']);
              if (!Number.isFinite(n)) continue;
              if (e.isIntersecting) {
                wanted.add(n);
                if (!canvases.has(n)) queue.push(n);
              } else {
                wanted.delete(n);
                release(n);
              }
            }
            pump();
          },
          // Render ~2 viewports ahead/behind; release beyond that.
          { rootMargin: '200% 0px' },
        );
        for (let n = 1; n <= pdf.numPages; n++) {
          const w = document.createElement('div');
          w.dataset['page'] = String(n);
          w.style.width = '100%';
          w.style.margin = '0 auto 12px';
          w.style.background = 'rgba(255,255,255,0.85)';
          placeholder(w, n);
          host.appendChild(w);
          wrappers.push(w);
          observer.observe(w);
        }
        setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setErrMsg(e instanceof Error ? e.message : 'render_failed');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      observer?.disconnect();
      for (const n of [...canvases.keys()]) release(n);
      void pdf?.destroy();
    };
  }, [url]);

  // Block Ctrl/Cmd+P while this viewer is mounted.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (status === 'error') {
    return (
      <p style={{ fontSize: 13, color: tokens.color.danger }}>
        The document couldn&apos;t be loaded{errMsg ? ` (${errMsg})` : ''}. Please try again
        shortly.
      </p>
    );
  }

  return (
    <div>
      {/* Hide the rendered document from any print output. */}
      <style>{`@media print { .vibe-pdf-protected { display: none !important; } }`}</style>
      {status === 'loading' && (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading document…</p>
      )}
      <div
        ref={hostRef}
        className="vibe-pdf-protected"
        onContextMenu={(e) => e.preventDefault()}
        style={{
          // Desktop: an inner scroll pane keeps the sections list in view.
          // Phones: let the PAGE scroll — a nested scroller fights pinch
          // zoom and swipe momentum on touch.
          ...(narrow ? {} : { maxHeight: '80vh', overflowY: 'auto' }),
          background: '#525659',
          padding: 12,
          borderRadius: tokens.radius.sm,
          userSelect: 'none',
        }}
      />
      {canDownload ? (
        <div style={{ marginTop: tokens.space.sm }}>
          <a href={downloadUrl ?? url} download={filename}>
            <Button variant="secondary" size="sm">
              Download PDF
            </Button>
          </a>
        </div>
      ) : (
        <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: tokens.space.sm }}>
          This document is view-only — saving and printing are disabled.
        </p>
      )}
    </div>
  );
}
