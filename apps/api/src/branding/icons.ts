// SPDX-License-Identifier: Elastic-2.0
//
// Server-side PWA icon generation for firm branding. Produces square PNGs at
// the sizes the portal manifest / Apple touch icon / push badge need, either
// from an uploaded square source image (centered + contained, with a safe-zone
// for maskable) or, as a fallback, a neutral accent-color "document + check"
// mark. Uses @napi-rs/canvas (no native ImageMagick needed).

import { createCanvas, loadImage } from '@napi-rs/canvas';

export interface IconSpec {
  /** Output edge length in px (square). */
  size: number;
  /** Maskable icons fill the whole canvas with bg + keep art in the safe zone. */
  maskable: boolean;
}

export const ICON_SPECS: Record<string, IconSpec> = {
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'icon-maskable-512.png': { size: 512, maskable: true },
  'apple-touch-icon-180.png': { size: 180, maskable: false },
};

const DEFAULT_ACCENT = '#0f6cbd';

function roundedRectPath(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A neutral document-with-check mark on the firm accent — the default when no
 *  square logo has been uploaded. Mirrors the bundled default icons. */
export function renderDefaultIcon(spec: IconSpec, accent = DEFAULT_ACCENT): Buffer {
  const { size, maskable } = spec;
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');

  ctx.fillStyle = accent;
  if (maskable) {
    ctx.fillRect(0, 0, size, size);
  } else {
    roundedRectPath(ctx, 0, 0, size, size, size * 0.22);
    ctx.fill();
  }

  const g = size * (maskable ? 0.62 : 0.82);
  const docW = g * 0.62;
  const docH = g * 0.78;
  const x = (size - docW) / 2;
  const y = (size - docH) / 2;
  ctx.fillStyle = '#ffffff';
  roundedRectPath(ctx, x, y, docW, docH, g * 0.07);
  ctx.fill();

  ctx.fillStyle = accent;
  const lineH = docH * 0.07;
  const lineX = x + docW * 0.16;
  const lineW = docW * 0.68;
  for (let i = 0; i < 3; i++) {
    const ly = y + docH * (0.2 + i * 0.16);
    ctx.fillRect(lineX, ly, i === 2 ? lineW * 0.6 : lineW, lineH);
  }

  const cx = x + docW * 0.74;
  const cy = y + docH * 0.74;
  const cr = docW * 0.26;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = cr * 0.28;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - cr * 0.42, cy + cr * 0.02);
  ctx.lineTo(cx - cr * 0.08, cy + cr * 0.36);
  ctx.lineTo(cx + cr * 0.46, cy - cr * 0.34);
  ctx.stroke();

  return c.toBuffer('image/png');
}

/**
 * Render an icon from an uploaded square source image: the source is scaled to
 * "contain" within the icon (or the maskable safe zone) and centered on the
 * firm accent background. Throws if the source can't be decoded (e.g. SVG).
 */
export async function renderIconFromSource(
  source: Buffer,
  spec: IconSpec,
  accent = DEFAULT_ACCENT,
): Promise<Buffer> {
  const { size, maskable } = spec;
  const img = await loadImage(source);
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');

  ctx.fillStyle = accent;
  if (maskable) {
    ctx.fillRect(0, 0, size, size);
  } else {
    roundedRectPath(ctx, 0, 0, size, size, size * 0.22);
    ctx.fill();
  }

  // Contain the art within a safe box (smaller for maskable so nothing is
  // cropped by the platform mask).
  const box = size * (maskable ? 0.66 : 0.82);
  const scale = Math.min(box / img.width, box / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);

  return c.toBuffer('image/png');
}
