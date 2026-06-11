// SPDX-License-Identifier: Elastic-2.0
//
// Append one PDF's pages to another. Used to store a signed document and
// its OpenSign audit certificate as a SINGLE artifact (signature pages
// followed by the certificate) instead of two separate downloads.

import { PDFDocument } from 'pdf-lib';

/** Append `extra`'s pages after `base`'s. Throws if either part isn't a
 *  loadable PDF — callers fall back to their legacy separate-file shape. */
export async function appendPdfPages(base: Buffer, extra: Buffer): Promise<Buffer> {
  const out = await PDFDocument.load(base, { ignoreEncryption: true });
  const add = await PDFDocument.load(extra, { ignoreEncryption: true });
  const pages = await out.copyPages(add, add.getPageIndices());
  for (const p of pages) out.addPage(p);
  return Buffer.from(await out.save());
}
