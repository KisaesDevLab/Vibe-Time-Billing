// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Drag-to-place field editor (P9). Renders the source PDF with pdf.js,
// overlays per-signer field boxes positioned in NORMALIZED coordinates
// (the source of truth — they survive any render scale), and lets staff
// add (click), move (drag), resize (corner handle), and delete fields.
// Save PUTs the whole normalized set; the server re-validates (coords in
// [0,1], inside the page, every signer ≥1 signature field).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Combobox, tokens } from '@vibe/ui';

import { api } from '../../api-client';

// pdf.js is heavy (~1MB) — load it only when the editor mounts so it never
// weighs down the rest of the staff app. Cached after the first load.
// (The indirection keeps the dynamic import out of a type annotation, which
//  the consistent-type-imports lint rule forbids.)
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

const PAGE_WIDTH = 700; // rendered page width in CSS px

// Mirror the backend per-signer color palette (opensign-document.ts) so
// the editor preview ≈ what signers see in OpenSign.
const SIGNER_COLORS = ['#0a5ad4', '#cc2d2d', '#1f9c4d', '#9436c4', '#d98300', '#0a8f96'];

const FIELD_TYPES = [
  { value: 'signature', label: 'Signature' },
  { value: 'initials', label: 'Initials' },
  { value: 'date', label: 'Date' },
  { value: 'text', label: 'Text' },
  { value: 'checkbox', label: 'Checkbox' },
];

// Default normalized size per field type.
const DEFAULT_SIZE: Record<string, { nw: number; nh: number }> = {
  signature: { nw: 0.26, nh: 0.05 },
  initials: { nw: 0.1, nh: 0.04 },
  date: { nw: 0.15, nh: 0.035 },
  text: { nw: 0.2, nh: 0.04 },
  checkbox: { nw: 0.04, nh: 0.03 },
};

interface Signer {
  id: string;
  name: string;
  role: string | null;
}
interface Placement {
  signerId: string;
  fieldType: string;
  pageNumber: number;
  nx: number;
  ny: number;
  nw: number;
  nh: number;
  required?: boolean;
}
interface RenderedPage {
  pageNumber: number;
  src: string;
  wPx: number;
  hPx: number;
}

interface Props {
  requestId: string;
  signers: Signer[];
  placements: Placement[];
  onSaved: () => void;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function FieldEditor({ requestId, signers, placements, onSaved }: Props): JSX.Element {
  const [pages, setPages] = useState<RenderedPage[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [items, setItems] = useState<Placement[]>(placements);
  const [activeSigner, setActiveSigner] = useState(signers[0]?.id ?? '');
  const [activeType, setActiveType] = useState('signature');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const colorFor = useCallback(
    (signerId: string): string => {
      const idx = signers.findIndex((s) => s.id === signerId);
      return SIGNER_COLORS[(idx < 0 ? 0 : idx) % SIGNER_COLORS.length]!;
    },
    [signers],
  );

  // Render every page to a data URL once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingPdf(true);
      setPdfError(null);
      try {
        const res = await fetch(`/api/staff/signatures/${requestId}/source`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error(`source_${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        const pdfjs = await loadPdfjs();
        const pdf = await pdfjs.getDocument({ data }).promise;
        const out: RenderedPage[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const base = page.getViewport({ scale: 1 });
          const scale = PAGE_WIDTH / base.width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext('2d')!;
          await page.render({ canvasContext: ctx, viewport }).promise;
          out.push({
            pageNumber: n,
            src: canvas.toDataURL('image/png'),
            wPx: canvas.width,
            hPx: canvas.height,
          });
        }
        if (!cancelled) setPages(out);
      } catch (err) {
        if (!cancelled) setPdfError(err instanceof Error ? err.message : 'pdf_render_failed');
      } finally {
        if (!cancelled) setLoadingPdf(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  const signerOptions = useMemo(
    () => signers.map((s) => ({ value: s.id, label: `${s.name}${s.role ? ` (${s.role})` : ''}` })),
    [signers],
  );

  function addFieldAt(pageNumber: number, nxCenter: number, nyCenter: number): void {
    if (!activeSigner) return;
    const size = DEFAULT_SIZE[activeType] ?? DEFAULT_SIZE['signature']!;
    const nx = clamp01(nxCenter - size.nw / 2);
    const ny = clamp01(nyCenter - size.nh / 2);
    setItems((prev) => [
      ...prev,
      {
        signerId: activeSigner,
        fieldType: activeType,
        pageNumber,
        nx: Math.min(nx, 1 - size.nw),
        ny: Math.min(ny, 1 - size.nh),
        nw: size.nw,
        nh: size.nh,
        required: true,
      },
    ]);
    setDirty(true);
  }

  function updateItem(index: number, patch: Partial<Placement>): void {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));
    setDirty(true);
  }
  function removeItem(index: number): void {
    setItems((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSaveMsg(null);
    try {
      await api(`/api/staff/signatures/${requestId}/placements`, {
        method: 'PUT',
        body: JSON.stringify({ placements: items }),
      });
      setDirty(false);
      setSaveMsg('Saved.');
      onSaved();
    } catch (err) {
      const body = (err as { body?: { errors?: Array<{ path: string; message: string }> } }).body;
      setSaveMsg(
        body?.errors?.length
          ? `Invalid: ${body.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`
          : err instanceof Error
            ? err.message
            : 'save_failed',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.md }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          padding: tokens.space.sm,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
        }}
      >
        <div style={{ minWidth: 200 }}>
          <Label>Signer</Label>
          <Combobox
            options={signerOptions}
            value={activeSigner}
            onChange={setActiveSigner}
            ariaLabel="Active signer"
          />
        </div>
        <div style={{ minWidth: 150 }}>
          <Label>Field</Label>
          <Combobox
            options={FIELD_TYPES}
            value={activeType}
            onChange={setActiveType}
            ariaLabel="Field type"
          />
        </div>
        <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
          Click a page to drop a field · drag to move · ⤡ to resize · × to remove
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {saveMsg && (
            <span
              style={{
                fontSize: 12,
                color: saveMsg === 'Saved.' ? tokens.color.success : tokens.color.danger,
              }}
            >
              {saveMsg}
            </span>
          )}
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save fields'}
          </Button>
        </div>
      </div>

      {/* Signer legend */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {signers.map((s) => (
          <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: colorFor(s.id),
                display: 'inline-block',
              }}
            />
            {s.name}
            {s.role ? ` (${s.role})` : ''}
          </span>
        ))}
      </div>

      {pdfError && (
        <div style={{ color: tokens.color.danger, fontSize: 13 }}>PDF error: {pdfError}</div>
      )}
      {loadingPdf && (
        <div style={{ color: tokens.color.textMuted, fontSize: 13 }}>Rendering PDF…</div>
      )}

      <div style={{ display: 'grid', gap: tokens.space.lg, justifyItems: 'center' }}>
        {pages.map((pg) => (
          <PageCanvas
            key={pg.pageNumber}
            page={pg}
            items={items}
            colorFor={colorFor}
            signerName={(id) => signers.find((s) => s.id === id)?.name ?? '?'}
            onAdd={(nxc, nyc) => addFieldAt(pg.pageNumber, nxc, nyc)}
            onUpdate={updateItem}
            onRemove={removeItem}
            indexOf={(it) => items.indexOf(it)}
          />
        ))}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>{children}</div>
  );
}

// ---- A single page with its overlay -----------------------------------

interface PageCanvasProps {
  page: RenderedPage;
  items: Placement[];
  colorFor: (signerId: string) => string;
  signerName: (signerId: string) => string;
  onAdd: (nxCenter: number, nyCenter: number) => void;
  onUpdate: (index: number, patch: Partial<Placement>) => void;
  onRemove: (index: number) => void;
  indexOf: (it: Placement) => number;
}

function PageCanvas({
  page,
  items,
  colorFor,
  signerName,
  onAdd,
  onUpdate,
  onRemove,
  indexOf,
}: PageCanvasProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    index: number;
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    orig: Placement;
  } | null>(null);

  const pageItems = items
    .map((it) => ({ it, index: indexOf(it) }))
    .filter((x) => x.it.pageNumber === page.pageNumber);

  function onPageClick(e: React.MouseEvent): void {
    // Only a click on the bare page (not a field) drops a new field.
    if (e.target !== e.currentTarget) return;
    const rect = ref.current!.getBoundingClientRect();
    const nxc = (e.clientX - rect.left) / rect.width;
    const nyc = (e.clientY - rect.top) / rect.height;
    onAdd(clamp01(nxc), clamp01(nyc));
  }

  function startDrag(e: React.MouseEvent, index: number, mode: 'move' | 'resize'): void {
    e.stopPropagation();
    e.preventDefault();
    const orig = items[index]!;
    drag.current = { index, mode, startX: e.clientX, startY: e.clientY, orig };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function onMove(e: MouseEvent): void {
    const d = drag.current;
    if (!d || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const dnx = (e.clientX - d.startX) / rect.width;
    const dny = (e.clientY - d.startY) / rect.height;
    if (d.mode === 'move') {
      onUpdate(d.index, {
        nx: clamp01(Math.min(d.orig.nx + dnx, 1 - d.orig.nw)),
        ny: clamp01(Math.min(d.orig.ny + dny, 1 - d.orig.nh)),
      });
    } else {
      const nw = Math.max(0.02, Math.min(d.orig.nw + dnx, 1 - d.orig.nx));
      const nh = Math.max(0.02, Math.min(d.orig.nh + dny, 1 - d.orig.ny));
      onUpdate(d.index, { nw, nh });
    }
  }
  function onUp(): void {
    drag.current = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  }

  return (
    <div style={{ position: 'relative', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}>
      {/* Pointer-only drag-to-place canvas — keyboard placement isn't
          meaningful for a spatial editor; fields are also editable via the
          per-field controls. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events */}
      <div
        ref={ref}
        onClick={onPageClick}
        style={{
          position: 'relative',
          width: page.wPx,
          height: page.hPx,
          backgroundImage: `url(${page.src})`,
          backgroundSize: 'cover',
          cursor: 'crosshair',
        }}
      >
        {pageItems.map(({ it, index }) => {
          const color = colorFor(it.signerId);
          return (
            // eslint-disable-next-line jsx-a11y/no-static-element-interactions
            <div
              key={index}
              onMouseDown={(e) => startDrag(e, index, 'move')}
              style={{
                position: 'absolute',
                left: `${it.nx * 100}%`,
                top: `${it.ny * 100}%`,
                width: `${it.nw * 100}%`,
                height: `${it.nh * 100}%`,
                border: `2px solid ${color}`,
                background: `${color}22`,
                borderRadius: 2,
                cursor: 'move',
                boxSizing: 'border-box',
                fontSize: 10,
                color,
                overflow: 'hidden',
                userSelect: 'none',
              }}
              title={`${signerName(it.signerId)} · ${it.fieldType}`}
            >
              <span style={{ padding: 1, pointerEvents: 'none' }}>{it.fieldType}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(index);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  border: 'none',
                  background: color,
                  color: '#fff',
                  fontSize: 10,
                  lineHeight: '16px',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                ×
              </button>
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
              <div
                onMouseDown={(e) => startDrag(e, index, 'resize')}
                style={{
                  position: 'absolute',
                  right: -4,
                  bottom: -4,
                  width: 10,
                  height: 10,
                  background: color,
                  cursor: 'nwse-resize',
                  borderRadius: 2,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          fontSize: 11,
          color: tokens.color.textMuted,
          background: 'rgba(255,255,255,0.7)',
          padding: '0 4px',
          borderRadius: 3,
          pointerEvents: 'none',
        }}
      >
        Page {page.pageNumber}
      </div>
    </div>
  );
}
