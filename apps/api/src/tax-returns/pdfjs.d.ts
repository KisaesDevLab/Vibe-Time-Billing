// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Minimal typings for the slice of pdfjs-dist's legacy ESM build we use
// in the tax-return parser (outline + per-page text). The package ships
// full types under a different entrypoint; this subpath import needs its
// own declaration.

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface TextItem {
    str?: string;
  }
  export interface PDFPageProxy {
    getTextContent(): Promise<{ items: TextItem[] }>;
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
  }
  export function getDocument(src: GetDocumentParams): { promise: Promise<PDFDocumentProxy> };
}
