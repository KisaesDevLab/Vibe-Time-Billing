// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Path utilities for the B2-backed storage layer.
//
// Key invariants:
//   - Storage uses forward slashes only. Windows backslashes get
//     normalized to '/' on the way in.
//   - Folder paths end with '/'. File keys never end with '/'.
//   - The sentinel folder name + filename are configurable via env;
//     callers pass them in rather than importing process.env here so
//     this module is environment-agnostic and easy to test.
//   - Sanitization is biased toward what Windows File Explorer will
//     accept, since the virtual-drive case is the constraint. POSIX
//     mounts will accept Windows-safe names too.

const FORBIDDEN_CHARS_RE = /[<>:"|?*\\]/g;
// Control chars 0-31 (incl. tab/newline) + DEL.
// reason: ranges are inclusive at the regex level; literal control
// chars in the class are fine in modern JS engines.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** Maximum length of any single path segment (Windows limit minus
 *  a few bytes of safety margin for collision suffixes). */
export const MAX_BASENAME_BYTES = 240;

/** Maximum total key length the backend will accept. B2's hard cap
 *  is 1024 bytes; we use the same. */
export const MAX_KEY_BYTES = 1024;

/**
 * Joins path segments with '/' separators. Normalizes backslashes,
 * collapses duplicate slashes, strips leading/trailing slashes on
 * intermediate segments. Preserves a trailing slash on the result if
 * the *last* segment ends with one (so callers can express folder vs
 * file intent explicitly).
 */
export function joinPath(...segments: string[]): string {
  if (segments.length === 0) return '';
  const trailing = segments[segments.length - 1]?.endsWith('/') ?? false;
  const cleaned = segments
    .map((s) =>
      s
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/|\/$/g, ''),
    )
    .filter((s) => s.length > 0);
  const joined = cleaned.join('/');
  if (joined.length === 0) return '';
  return trailing ? `${joined}/` : joined;
}

/**
 * Last non-empty segment of a folder path or key — the folder's own
 * name, independent of where it lives in the bucket. With
 * STORAGE_TOP_PREFIX set (e.g. `Client Files/`), stored paths look
 * like `Client Files/Smith, John/`; matching and display must use
 * `Smith, John`, never the full path.
 */
export function folderBasename(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? '';
}

/**
 * Normalizes STORAGE_TOP_PREFIX for key composition: '' stays '',
 * anything else gets slashes trimmed and exactly one trailing '/'.
 */
export function normalizeTopPrefix(prefix: string | undefined): string {
  const trimmed = (prefix ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .trim();
  return trimmed.length > 0 ? `${trimmed}/` : '';
}

/**
 * Splits a key like `Smith, John & Mary/Invoices/2024 inv.pdf` into
 * the top-level client-folder path (with trailing slash) and the
 * remaining sub-path. Used by the sync worker to attribute newly
 * discovered files to a client folder.
 */
export function splitClientFolder(key: string): {
  clientFolderPath: string;
  subPath: string;
} {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = normalized.indexOf('/');
  if (slash < 0) {
    // No slash → the key IS a top-level item (file at the root of
    // the bucket area, not inside any client folder).
    return { clientFolderPath: '', subPath: normalized };
  }
  return {
    clientFolderPath: `${normalized.slice(0, slash)}/`,
    subPath: normalized.slice(slash + 1),
  };
}

/**
 * Returns true if the key is the sentinel file for some client
 * folder. Sentinel layout: `<clientFolder>/<sentinelFolder>/<sentinelFile>`.
 */
export function isSentinelPath(key: string, sentinelFolder: string, sentinelFile: string): boolean {
  const normalized = key.replace(/\\/g, '/');
  const needle = `/${sentinelFolder}/${sentinelFile}`;
  return normalized.endsWith(needle);
}

/**
 * Sanitizes a single path segment for Windows compatibility.
 *
 *   1. Reject empty → '_'.
 *   2. Strip forbidden chars (<>:"|?*\) and replace with '_'.
 *   3. Strip control chars.
 *   4. Trim trailing dots and spaces (Windows refuses these).
 *   5. If the base of the name (pre-extension) matches a reserved
 *      device name (CON, PRN, ...), prepend an underscore.
 *   6. Truncate to MAX_BASENAME_BYTES while preserving extension.
 *
 * Returns the safe name. Always non-empty.
 */
export function sanitizeForWindows(input: string): string {
  let s = input ?? '';
  // Normalize slashes to space — segments shouldn't contain them.
  s = s.replace(/[\\/]/g, '_');
  s = s.replace(FORBIDDEN_CHARS_RE, '_');
  s = s.replace(CONTROL_CHARS_RE, '');
  // Trim trailing dots/spaces (Explorer strips these silently).
  s = s.replace(/[. ]+$/g, '');
  if (s.length === 0) return '_';

  // Check reserved device names against the basename portion only.
  const dot = s.lastIndexOf('.');
  const base = dot > 0 ? s.slice(0, dot) : s;
  const ext = dot > 0 ? s.slice(dot) : '';
  if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
    s = `_${base}${ext}`;
  }

  // Truncate to byte budget, preserving extension if possible.
  if (Buffer.byteLength(s, 'utf8') > MAX_BASENAME_BYTES) {
    const extBytes = Buffer.byteLength(ext, 'utf8');
    const baseBudget = MAX_BASENAME_BYTES - extBytes;
    let trimmed = base;
    while (Buffer.byteLength(trimmed, 'utf8') > baseBudget && trimmed.length > 1) {
      trimmed = trimmed.slice(0, -1);
    }
    s = trimmed + ext;
  }

  return s;
}

/**
 * Given a desired key and a predicate that checks whether a key is
 * already in use, returns a free key by appending ` (2)`, ` (3)`, …
 * before the extension. Stops at 999 attempts and throws.
 *
 * The predicate is async so callers can backed it with a real HEAD.
 */
export async function resolveCollision(
  desiredKey: string,
  exists: (key: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(desiredKey))) return desiredKey;
  // Find the last segment and split its basename + extension.
  const slash = desiredKey.lastIndexOf('/');
  const dir = slash >= 0 ? desiredKey.slice(0, slash + 1) : '';
  const file = slash >= 0 ? desiredKey.slice(slash + 1) : desiredKey;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  for (let i = 2; i <= 999; i++) {
    const candidate = `${dir}${base} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`resolveCollision: exhausted 999 attempts for ${desiredKey}`);
}

/**
 * Enforces the total key byte cap. Returns the same key if within
 * budget; otherwise truncates the last segment's basename (preserving
 * extension) until the total fits.
 */
export function enforceKeyByteCap(key: string): string {
  if (Buffer.byteLength(key, 'utf8') <= MAX_KEY_BYTES) return key;
  const slash = key.lastIndexOf('/');
  const dir = slash >= 0 ? key.slice(0, slash + 1) : '';
  const file = slash >= 0 ? key.slice(slash + 1) : key;
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  const dirBytes = Buffer.byteLength(dir, 'utf8');
  const extBytes = Buffer.byteLength(ext, 'utf8');
  const baseBudget = MAX_KEY_BYTES - dirBytes - extBytes;
  if (baseBudget < 1) {
    // Even the directory + extension exceed the cap. Fail loud — the
    // caller is doing something weird.
    throw new Error(`enforceKeyByteCap: cannot fit ${key} within ${MAX_KEY_BYTES} bytes`);
  }
  let trimmed = base;
  while (Buffer.byteLength(trimmed, 'utf8') > baseBudget && trimmed.length > 0) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${dir}${trimmed}${ext}`;
}
