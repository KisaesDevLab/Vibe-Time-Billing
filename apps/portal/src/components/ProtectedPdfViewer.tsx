// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// ProtectedPdfViewer — renders a PDF to <canvas> via pdf.js (never the
// native browser viewer), so there's no download/print toolbar. We also
// suppress the right-click menu and hide the canvases from print output.
// Used by the client portal tax-return viewer and the 3rd-party
// recipient page. Note: this stops casual save/print, not a determined
// screenshot.

import { useEffect, useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

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

  useEffect(() => {
    let cancelled = false;
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
        const pdf = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;
        const host = hostRef.current;
        if (!host) return;
        host.innerHTML = '';
        const RENDER_W = 1100;
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(2, RENDER_W / base.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          canvas.style.display = 'block';
          canvas.style.margin = '0 auto 12px';
          canvas.style.boxShadow = '0 1px 6px rgba(0,0,0,0.3)';
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          host.appendChild(canvas);
        }
        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (!cancelled) {
          setErrMsg(e instanceof Error ? e.message : 'render_failed');
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
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
          maxHeight: '80vh',
          overflowY: 'auto',
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
