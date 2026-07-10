// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP8 — Conservative SVG sanitizer for engagement-letter signatures.
//
// Inputs are drawn signatures from the portal signature pad. The pad
// produces a small <svg> with <path d="..."> elements built from
// pointer events. We sanitize on the server before persisting so a
// malicious client can't sneak <script> or <foreignObject> in.
//
// Approach: regex-based allowlist. The signature pad output is simple
// enough that we don't need a real DOM parser; we just:
//   1. Strip everything outside the outermost <svg>...</svg>.
//   2. Reject if it contains any disallowed tag (script, foreignObject,
//      iframe, image, style, use, etc.).
//   3. Reject if any attribute references javascript: or data: URIs.
//   4. Bound size (10 KB hard cap — a hand signature is ~2-5 KB).
//
// On reject we return null; the caller surfaces a 400.

const MAX_BYTES = 10_240;

// Tags allowed inside an <svg> signature. Anything else is a reject.
const ALLOWED_TAG_RE = /^(svg|g|path|polyline|polygon|line|rect|circle|ellipse|title|desc)$/i;

export function sanitizeSignatureSvg(input: string): string | null {
  if (typeof input !== 'string') return null;
  if (input.length === 0 || input.length > MAX_BYTES) return null;

  // Must open with <svg and close with </svg>. Strip any wrapper / DOCTYPE.
  const openIdx = input.indexOf('<svg');
  const closeIdx = input.lastIndexOf('</svg>');
  if (openIdx < 0 || closeIdx < 0 || closeIdx < openIdx) return null;
  const svg = input.slice(openIdx, closeIdx + '</svg>'.length);

  // Reject any disallowed tag. Match opening tag names only.
  const tagRe = /<([!a-z][^\s>/]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg))) {
    const name = m[1]!;
    // !-- comments are stripped wholesale below; tolerate them here.
    if (name.startsWith('!')) continue;
    if (!ALLOWED_TAG_RE.test(name)) return null;
  }

  // Reject inline event handlers + javascript: / data: URIs.
  if (/\s(on[a-z]+|xlink:href|href)\s*=\s*"(javascript|data):/i.test(svg)) return null;
  if (/\son[a-z]+\s*=/i.test(svg)) return null;

  // Strip HTML comments to avoid weird parser surprises downstream.
  return svg.replace(/<!--[\s\S]*?-->/g, '');
}
