// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Reusable "Import defaults from library" panel for the catalog admin pages.
// Lists the shipped system templates for one area, flags which are already
// imported, and clones the selected (or all) into the firm's own catalog via
// /api/staff/template-library/:area/import. Used by Services Catalog,
// Packages, Terms Templates, and Notification Templates.

import { useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

export type LibraryArea =
  | 'services'
  | 'packages'
  | 'terms'
  | 'emails'
  | 'engagements'
  | 'letters'
  | 'requests'
  | 'clients';

interface LibraryItem {
  slug: string;
  name: string;
  category?: string;
  kind?: string;
  imported: boolean;
}

const AREA_LABEL: Record<LibraryArea, string> = {
  services: 'service',
  packages: 'package',
  terms: 'engagement-letter',
  emails: 'email',
  engagements: 'engagement-template',
  letters: 'engagement-letter',
  requests: 'request',
  clients: 'client-template',
};

export function TemplateLibraryPanel({
  area,
  onImported,
}: {
  area: LibraryArea;
  /** Called after a successful import so the host page can refresh its list. */
  onImported: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadList(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ items: LibraryItem[] }>(`/api/staff/template-library/${area}`);
      setItems(r.items ?? []);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }

  function toggleOpen(): void {
    const next = !open;
    setOpen(next);
    setMsg(null);
    if (next && items.length === 0) void loadList();
  }

  function toggle(slug: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function runImport(slugs?: string[]): Promise<void> {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const r = await api<{ imported: number; skipped: number; total: number }>(
        `/api/staff/template-library/${area}/import`,
        { method: 'POST', body: JSON.stringify(slugs ? { slugs } : {}) },
      );
      setMsg(`Imported ${r.imported}, skipped ${r.skipped} already present.`);
      await loadList();
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'import_failed');
    } finally {
      setBusy(false);
    }
  }

  const notImported = items.filter((i) => !i.imported);
  const selectable = selected.size > 0;

  return (
    <Card
      title="Import defaults from library"
      action={
        <Button size="sm" variant={open ? 'secondary' : 'ghost'} onClick={toggleOpen}>
          {open ? 'Hide' : `＋ Browse ${AREA_LABEL[area]} defaults`}
        </Button>
      }
    >
      <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: open ? '0 0 10px' : 0 }}>
        Seed your catalog with Vibe&apos;s ready-made {AREA_LABEL[area]} templates. Imported items
        become your own editable copies — re-importing never duplicates or overwrites them.
      </p>

      {open && (
        <div style={{ display: 'grid', gap: 10 }}>
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
              {error}
            </p>
          )}
          {msg && <p style={{ color: tokens.color.success, fontSize: 12, margin: 0 }}>{msg}</p>}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              size="sm"
              disabled={busy || loading || notImported.length === 0}
              onClick={() => void runImport()}
            >
              {busy ? 'Importing…' : `Import all (${notImported.length})`}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || loading || !selectable}
              onClick={() => void runImport(Array.from(selected))}
            >
              Import selected ({selected.size})
            </Button>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void loadList()}>
              Refresh
            </Button>
          </div>

          {loading ? (
            <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
          ) : (
            <div
              style={{
                display: 'grid',
                gap: 2,
                maxHeight: 320,
                overflowY: 'auto',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                padding: 6,
              }}
            >
              {items.length === 0 && (
                <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 6 }}>
                  No templates available.
                </p>
              )}
              {items.map((it) => (
                <label
                  key={it.slug}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '5px 6px',
                    borderRadius: tokens.radius.sm,
                    fontSize: 13,
                    opacity: it.imported ? 0.6 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={it.imported}
                    checked={it.imported || selected.has(it.slug)}
                    onChange={() => toggle(it.slug)}
                  />
                  <span style={{ flex: 1 }}>{it.name}</span>
                  {(it.category || it.kind) && (
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      {it.category ?? it.kind}
                    </span>
                  )}
                  {it.imported && <Pill tone="success">imported</Pill>}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
