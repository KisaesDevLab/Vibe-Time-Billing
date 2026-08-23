// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Minimal typings for the slice of pdfjs-dist's legacy ESM build we use
// in the tax-return parser (outline + per-page text). The package ships
// full types under a different entrypoint; this subpath import needs its
// own declaration.

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface TextItem {
    str?: string;
  }
  export interface PageViewport {
    width: number;
    height: number;
  }
  export interface PDFPageProxy {
    getTextContent(): Promise<{ items: TextItem[] }>;
    // 0223 — page rasterisation for AI file naming. `canvasContext` is a
    // node-canvas 2D context at runtime; typed loosely here on purpose.
    getViewport(params: { scale: number }): PageViewport;
    render(params: { canvasContext: unknown; viewport: PageViewport }): { promise: Promise<void> };
  }
  export interface OutlineItem {
    title: string;
    dest: string | unknown[] | null;
    items?: OutlineItem[];
  }
  export interface PDFDocumentProxy {
    numPages: number;
    getOutline(): Promise<OutlineItem[] | null>;
    getDestination(id: string): Promise<unknown[] | null>;
    getPageIndex(ref: unknown): Promise<number>;
    getPage(pageNumber: number): Promise<PDFPageProxy>;
    destroy(): Promise<void>;
  }
  export interface GetDocumentParams {
    data: Uint8Array;
    isEvalSupported?: boolean;
    useSystemFonts?: boolean;
    disableFontFace?: boolean;
    standardFontDataUrl?: string;
  }
  export function getDocument(src: GetDocumentParams): { promise: Promise<PDFDocumentProxy> };
}
