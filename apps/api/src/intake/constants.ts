// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shared intake vocabulary used by BOTH processes: the worker's
// intake-process job (scan + PDF assembly) and the API's staff routes +
// AI-label consumer. One definition each, so the "which images were
// embedded into the assembled scan PDF" decision and the scan PDF's
// display name can never drift between apps (review finding).

/** Display name for the assembled scan PDF, everywhere it is shown,
 *  prompted, or filed. */
export const SCAN_DISPLAY_NAME = 'Scanned documents.pdf';

/** Image kinds intake-process embeds into the assembled scan PDF. */
export const EMBEDDABLE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

/** Case-insensitive membership test both apps must use. */
export function isEmbeddableImage(mime: string | null | undefined): boolean {
  return EMBEDDABLE_IMAGE_MIMES.has((mime ?? '').toLowerCase());
}
