// SPDX-License-Identifier: Elastic-2.0
//
// P07 — Terms templates admin page (ADDENDUM-PROPOSAL-MODULE.md §P07).
//
// Lists templates grouped by category, with editor + preview panel.
// "Seed starters" button installs the 6 starter engagement-letter
// templates if they aren't already present. Disclaimer banner kept
// visible above the list.

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { TemplateLibraryPanel } from './TemplateLibraryPanel';
import { RichTextEditor, type RichTextVariable } from '../../proposal-editor/RichTextEditor';

const CATEGORIES = ['TAX', 'BOOKKEEPING', 'AUDIT', 'ADVISORY', 'PAYROLL', 'CFO'] as const;
type Category = (typeof CATEGORIES)[number];

interface TermsRow {
  id: string;
  category: Category;
  name: string;
  contentMd: string;
  version: number;
  isDefault: boolean;
  archivedAt: string | null;
  updatedAt: string;
}

// Merge variables offered in the editor's "Insert variable" dropdown. Terms
// templates are applied in both proposal and engagement-letter contexts, so the
// engagement.* tokens are offered here too.
const TERMS_VARIABLES: RichTextVariable[] = [
  { token: 'client.name', label: 'Client name' },
  { token: 'client.primary_email', label: 'Client email' },
  { token: 'firm.name', label: 'Firm name' },
  { token: 'firm.address', label: 'Firm address' },
  { token: 'firm.phone', label: 'Firm phone' },
  { token: 'engagement.name', label: 'Engagement name' },
  { token: 'engagement.start_date', label: 'Engagement start date' },
  { token: 'engagement.end_date', label: 'Engagement end date' },
  { token: 'today', label: "Today's date" },
];

export function TermsTemplatesPage(): JSX.Element {
  const [items, setItems] = useState<TermsRow[]>([]);
  const [filterCategory, setFilterCategory] = useState<Category | ''>('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TermsRow | null>(null);
  const [previewOutput, setPreviewOutput] = useState<string | null>(null);
  const [previewUnresolved, setPreviewUnresolved] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // Create form
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('TAX');

  async function load(): Promise<void> {
    const params = new URLSearchParams();
    if (filterCategory) params.set('category', filterCategory);
    if (includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    const r = await api<{ items: TermsRow[] }>(`/api/staff/terms-templates${qs ? `?${qs}` : ''}`);
    setItems(r.items ?? []);
  }

  useEffect(() => {
    void load().catch((e) => setErr(e instanceof Error ? e.message : 'load_failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCategory, includeArchived]);

  useEffect(() => {
    const found = selectedId ? (items.find((i) => i.id === selectedId) ?? null) : null;
    setDraft(found);
    setPreviewOutput(null);
    setPreviewUnresolved([]);
  }, [selectedId, items]);

  async function createTemplate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    try {
      await api('/api/staff/terms-templates', {
        method: 'POST',
        body: JSON.stringify({ category: newCategory, name: newName, contentMd: '' }),
      });
      setNewName('');
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    }
  }

  async function saveDraft(): Promise<void> {
    if (!draft) return;
    setErr(null);
    try {
      await api(`/api/staff/terms-templates/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: draft.name,
          category: draft.category,
          contentMd: draft.contentMd,
        }),
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'save_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/terms-templates/${id}/archive`, { method: 'POST', body: '{}' });
      if (id === selectedId) setSelectedId(null);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  async function restore(id: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/terms-templates/${id}/restore`, { method: 'POST', body: '{}' });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'restore_failed');
    }
  }

  async function makeDefault(id: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/terms-templates/${id}/make-default`, {
        method: 'POST',
        body: '{}',
      });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'make_default_failed');
    }
  }

  async function seedStarters(): Promise<void> {
    setErr(null);
    try {
      const r = await api<{ inserted: number; skipped: number }>(
        '/api/staff/terms-templates/seed-starters',
        { method: 'POST', body: '{}' },
      );
      await load();
      alert(`Seeded ${r.inserted} new template(s). Skipped ${r.skipped} already-existing.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'seed_failed');
    }
  }

  async function runPreview(): Promise<void> {
    if (!draft) return;
    setErr(null);
    try {
      const r = await api<{ output: string; unresolvedTokens: string[] }>(
        `/api/staff/terms-templates/${draft.id}/preview`,
        {
          method: 'POST',
          body: JSON.stringify({
            context: {
              client: { name: 'Acme Co', primary_email: 'cfo@acme.example' },
              firm: { name: 'Smith CPAs', phone: '(555) 555-1212', address: '123 Main St' },
              engagement: {
                name: 'Annual Tax 2026',
                start_date: '2026-01-15',
                end_date: '2026-04-15',
              },
              today: new Date().toISOString().slice(0, 10),
            },
          }),
        },
      );
      setPreviewOutput(r.output);
      setPreviewUnresolved(r.unresolvedTokens);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'preview_failed');
    }
  }

  const byCategory = useMemo(() => {
    const groups: Record<string, TermsRow[]> = {};
    for (const i of items) {
      (groups[i.category] ??= []).push(i);
    }
    return groups;
  }, [items]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1300 }}>
      <SectionHeading
        title="Terms templates"
        description="Reusable engagement-letter language. Proposals snapshot the rendered terms at send + acceptance time."
      />

      <TemplateLibraryPanel area="terms" onImported={() => void load()} />

      <Card>
        <div
          style={{
            padding: 12,
            background: tokens.color.accentMuted,
            color: tokens.color.accent,
            borderRadius: tokens.radius.sm,
            fontSize: 13,
          }}
        >
          These templates are starting points — review with your professional liability carrier
          before use. Template changes do not affect previously-signed proposals (each proposal
          freezes its terms at send and again at acceptance).
        </div>
      </Card>

      <Card title="Library">
        <form
          onSubmit={createTemplate}
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Input
            placeholder="New template name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            style={{ minWidth: 240 }}
          />
          <div style={{ width: 160 }}>
            <Combobox
              ariaLabel="Category"
              value={newCategory}
              onChange={(v) => setNewCategory((v as Category) ?? 'TAX')}
              options={CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          </div>
          <Button type="submit" size="sm">
            Create
          </Button>
          <div style={{ flex: 1 }} />
          <div style={{ width: 160 }}>
            <Combobox
              ariaLabel="Filter category"
              value={filterCategory}
              onChange={(v) => setFilterCategory((v as Category | '') ?? '')}
              options={[
                { value: '', label: 'All categories' },
                ...CATEGORIES.map((c) => ({ value: c, label: c })),
              ]}
            />
          </div>
          <label style={{ fontSize: 12, color: tokens.color.textMuted }}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Include archived
          </label>
          <Button size="sm" variant="ghost" onClick={() => void seedStarters()}>
            Seed 6 starters
          </Button>
        </form>

        {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}

        {Object.keys(byCategory).length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            No templates yet. Create one above, or click &quot;Seed 6 starters&quot; for AICPA-style
            starter language across all six categories.
          </p>
        ) : (
          CATEGORIES.filter((c) => byCategory[c]?.length).map((cat) => (
            <div key={cat} style={{ marginBottom: 12 }}>
              <div
                style={{
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}
              >
                {cat}
              </div>
              <div style={{ display: 'grid', gap: 4 }}>
                {byCategory[cat]!.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    style={{
                      textAlign: 'left',
                      padding: tokens.space.sm,
                      border: `1px solid ${
                        row.id === selectedId ? tokens.color.accent : tokens.color.border
                      }`,
                      borderRadius: tokens.radius.sm,
                      background:
                        row.id === selectedId ? tokens.color.accentMuted : tokens.color.surface,
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{row.name}</span>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      v{row.version}
                    </span>
                    {row.isDefault && <Pill tone="accent">Default</Pill>}
                    {row.archivedAt && <Pill tone="warning">Archived</Pill>}
                    <div style={{ flex: 1 }} />
                    {!row.isDefault && !row.archivedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void makeDefault(row.id);
                        }}
                      >
                        Make default
                      </Button>
                    )}
                    {row.archivedAt ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void restore(row.id);
                        }}
                      >
                        Restore
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void archive(row.id);
                        }}
                      >
                        Archive
                      </Button>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>

      {draft && (
        <Card
          title={`Edit — ${draft.name} (v${draft.version})`}
          action={
            <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          }
        >
          <div style={{ display: 'grid', gap: 8 }}>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Template name"
            />
            <RichTextEditor
              key={draft.id}
              value={draft.contentMd}
              onChange={(md) => setDraft((d) => (d ? { ...d, contentMd: md } : d))}
              variables={TERMS_VARIABLES}
              placeholder="Engagement-letter terms. Use the toolbar to format and the Variable ▾ menu to insert merge fields."
            />
            <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
              Use the <strong>Variable ▾</strong> menu in the toolbar to insert merge fields like{' '}
              <code>{'{{ client.name }}'}</code>. Unbound values resolve to empty at send time.
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              marginTop: 12,
              justifyContent: 'flex-end',
            }}
          >
            <Button size="sm" variant="ghost" onClick={() => void runPreview()}>
              Preview with sample data
            </Button>
            <Button size="sm" onClick={() => void saveDraft()}>
              Save (bumps to v{draft.version + 1})
            </Button>
          </div>
          {previewOutput != null && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                background: tokens.color.bg,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 6 }}>
                Preview output
              </div>
              {previewOutput}
              {previewUnresolved.length > 0 && (
                <div style={{ marginTop: 8, color: tokens.color.warning }}>
                  Unresolved tokens: {previewUnresolved.join(', ')}
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
