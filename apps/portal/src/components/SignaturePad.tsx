// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP8 — Touch + mouse signature pad. Captures pointer events as a
// series of SVG <path d="..."/> elements. Output is a small <svg>
// blob the portal POSTs alongside the engagement-letter accept call.
//
// Why SVG (not canvas): SVG renders crisply at any DPI, embeds
// directly into the rendered letter HTML/PDF, and stays small
// (~2-5 KB for a typical signature). Canvas rasterization would
// require sending a base64 PNG.

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

export interface SignaturePadProps {
  width?: number;
  height?: number;
  /** Called with the captured SVG markup (or null when cleared). */
  onChange: (svg: string | null) => void;
  /** Display-only — caller wires the actual reset button if needed. */
  disabled?: boolean;
}

interface Stroke {
  points: Array<{ x: number; y: number }>;
}

export function SignaturePad({
  width = 480,
  height = 160,
  onChange,
  disabled,
}: SignaturePadProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [drawing, setDrawing] = useState(false);

  // Whenever the strokes change, emit the resulting SVG.
  useEffect(() => {
    if (strokes.length === 0) {
      onChange(null);
      return;
    }
    onChange(buildSvg(width, height, strokes));
  }, [strokes, width, height, onChange]);

  const getPoint = useCallback(
    (e: React.PointerEvent<SVGSVGElement>): { x: number; y: number } => {
      const rect = svgRef.current!.getBoundingClientRect();
      // Scale page pixels to the SVG viewBox so stroke geometry is
      // independent of the display size.
      const scaleX = width / rect.width;
      const scaleY = height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    },
    [width, height],
  );

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>): void {
    if (disabled) return;
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = getPoint(e);
    setDrawing(true);
    setStrokes((prev) => [...prev, { points: [p] }]);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>): void {
    if (!drawing || disabled) return;
    const p = getPoint(e);
    setStrokes((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!;
      const merged: Stroke = { points: [...last.points, p] };
      return [...prev.slice(0, -1), merged];
    });
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>): void {
    if (!drawing) return;
    svgRef.current?.releasePointerCapture(e.pointerId);
    setDrawing(false);
  }

  function clear(): void {
    setStrokes([]);
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        style={{
          width: '100%',
          maxWidth: width,
          height: 'auto',
          aspectRatio: `${width} / ${height}`,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          touchAction: 'none',
          cursor: disabled ? 'not-allowed' : 'crosshair',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {strokes.map((s, i) => (
          <path
            key={i}
            d={strokeToPath(s)}
            fill="none"
            stroke={tokens.color.text}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {strokes.length === 0 && (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={tokens.color.textMuted}
            fontSize={14}
          >
            Sign here
          </text>
        )}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
          Draw with your finger, stylus, or mouse.
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clear}
          disabled={strokes.length === 0}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

function strokeToPath(stroke: Stroke): string {
  if (stroke.points.length === 0) return '';
  const [first, ...rest] = stroke.points;
  const parts = [`M ${round(first!.x)} ${round(first!.y)}`];
  for (const p of rest) parts.push(`L ${round(p.x)} ${round(p.y)}`);
  return parts.join(' ');
}

function round(n: number): string {
  return n.toFixed(1);
}

function buildSvg(width: number, height: number, strokes: Stroke[]): string {
  const paths = strokes
    .map(
      (s) =>
        `<path d="${strokeToPath(s)}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${paths}</svg>`;
}
