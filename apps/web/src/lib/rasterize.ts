// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client-intake fallback: turn an uploaded image or PDF into a base64 PNG for
// the GLM-OCR endpoint. Used when native window capture isn't available
// (browser, or an RDP/Citrix host where capture returns black frames): the
// user prints/exports the General Information screen and uploads it here.
//
// The pdfjs loader mirrors signatures/FieldEditor.tsx so Vite bundles the
// worker the same way.

// The indirection keeps the dynamic import out of a type annotation, which
// the consistent-type-imports lint rule forbids.
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

// ~200 DPI (200/72) to match the backend raster DPI so small SSN/EIN-adjacent
// text OCRs reliably. First page only — the General Information screen is one
// page.
const RASTER_SCALE = 200 / 72;

function base64FromDataUrl(dataUrl: string): string {
  return dataUrl.split(',')[1] ?? '';
}

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

async function pdfFirstPageToPngBase64(file: File): Promise<string> {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: RASTER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return base64FromDataUrl(canvas.toDataURL('image/png'));
}

function imageToPngBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(base64FromDataUrl(String(reader.result)));
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

/** Convert an uploaded PNG/JPG/PDF (first page) into a base64 PNG string. */
export async function fileToPngBase64(file: File): Promise<string> {
  return isPdf(file) ? pdfFirstPageToPngBase64(file) : imageToPngBase64(file);
}
