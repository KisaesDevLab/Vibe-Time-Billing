// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Helpers for files that arrive from a phone camera. Kept DOM-free so they
// unit-test under node.

/** Extension → mime for camera files whose blob.type is empty (common for
 *  HEIC in Android WebViews). Unknown stays octet-stream so the server
 *  rejects it by name rather than the worker choking on the bytes. */
const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

export const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/tiff': 'tif',
};

/**
 * The mime to send for a camera file. NEVER guess 'image/jpeg': a HEIC
 * mislabelled as JPEG is accepted by the server and then throws inside the
 * worker's pdf-lib embed, which used to cost the visitor the assembled PDF
 * for every page in the session.
 */
export function inferCaptureMime(blob: Pick<Blob, 'type'>, filename?: string): string {
  if (blob.type) return blob.type;
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const byExt = dot >= 0 ? EXT_MIME[name.slice(dot)] : undefined;
  return byExt ?? 'application/octet-stream';
}

/** Turn the API's error codes into something a visitor can act on, and say
 *  which file failed — a bare 'unsupported_type' told them nothing. */
export function describeUploadError(code: string, filename: string): string {
  switch (code) {
    case 'unsupported_type':
      return `"${filename}" is a file type we can't accept. Try a PDF, JPG or PNG.`;
    case 'file_too_large':
      return `"${filename}" is too large — files must be 25 MB or smaller.`;
    case 'too_many_files':
      return `"${filename}" exceeds the limit of 30 files per submission.`;
    default:
      return `"${filename}" could not be uploaded. Please remove it and try again.`;
  }
}
