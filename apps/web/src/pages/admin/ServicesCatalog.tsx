// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P02 — Services catalog admin page (ADDENDUM-PROPOSAL-MODULE.md §P02).
//
// Mounted at /admin/services. Two stacked panels:
//   1. Tags — small CRUD for the firm's tag list
//   2. Services — main grid with filters, create/edit, archive/restore,
//      bulk-price action
//
// Soft-delete semantics: archived services hide from the default list
// but show up under "Include archived." Restore flips archived_at back.
// Bulk-price applies a percent or flat delta to selected services.

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Combobox, Input, Pill, SectionHeading, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { TemplateLibraryPanel } from './TemplateLibraryPanel';

// 0216 — categories are firm-managed: the option list is the Taxonomy
// service-line categories (Admin → Taxonomy), plus any value already in use.
type Category = string;

const BILLING_TYPES = [
  'ONE_TIME',
  'RECURRING',
  'ON_COMPLETION',
  'SPLIT_DEPOSIT_RECURRING',
] as const;
type BillingType = (typeof BILLING_TYPES)[number];

const INTERVALS = ['MONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'ANNUALLY'] as const;
type Interval = (typeof INTERVALS)[number];

interface TagRow {
  id: string;
  name: string;
  color: string | null;
}

interface ServiceRow {
  id: string;
  name: string;
  description: string;
  category: Category;
  defaultPriceCents: number;
  billingType: BillingType;
  recurringInterval: Interval | null;
  isAddon: boolean;
  parentServiceId: string | null;
  coaCode: string | null;
  archivedAt: string | null;
  tags: TagRow[];
}

interface DraftService {
  id?: string;
  name: string;
  description: string;
  category: Category;
  defaultPriceCents: number;
  billingType: BillingType;
  recurringInterval: Interval | null;
  isAddon: boolean;
  parentServiceId: string | null;
  coaCode: string | null;
  tagIds: string[];
}

function emptyDraft(): DraftService {
  return {
    name: '',
    description: '',
    category: '',
    defaultPriceCents: 0,
    billingType: 'ONE_TIME',
    recurringInterval: null,
    isAddon: false,
    parentServiceId: null,
    coaCode: null,
    tagIds: [],
  };
}

function dollarsFromCents(c: number): string {
  return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function centsFromDollars(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function ServicesCatalogPage(): JSX.Element {
  const [tags, setTags] = useState<TagRow[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [filterCategory, setFilterCategory] = useState<Category | ''>('');
  const [filterTagId, setFilterTagId] = useState<string>('');
  const [filterQuery, setFilterQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<DraftService | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [taxonomyCategories, setTaxonomyCategories] = useState<string[]>([]);

  async function loadTags(): Promise<void> {
    const r = await api<{ items: TagRow[] }>('/api/staff/service-tags');
    setTags(r.items ?? []);
  }

  // Category options come from the Taxonomy service lines (best-effort).
  async function loadTaxonomyCategories(): Promise<void> {
    try {
      const r = await api<{ items: { category: string }[] }>('/api/staff/taxonomy/service-lines');
      setTaxonomyCategories([...new Set((r.items ?? []).map((i) => i.category).filter(Boolean))]);
    } catch {
      setTaxonomyCategories([]);
    }
  }

  async function loadServices(): Promise<void> {
    const params = new URLSearchParams();
    if (filterCategory) params.set('category', filterCategory);
    if (filterTagId) params.set('tagId', filterTagId);
    if (filterQuery.trim()) params.set('q', filterQuery.trim());
    if (includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    const r = await api<{ items: ServiceRow[] }>(`/api/staff/services${qs ? `?${qs}` : ''}`);
    setServices(r.items ?? []);
    setLoaded(true);
  }

  useEffect(() => {
    void loadTags();
    void loadTaxonomyCategories();
  }, []);

  useEffect(() => {
    void loadServices().catch((e) => setErr(e instanceof Error ? e.message : 'load_failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCategory, filterTagId, includeArchived]);

  async function saveDraft(): Promise<void> {
    if (!draft) return;
    setErr(null);
    if (!draft.category.trim()) {
      setErr('Pick a category — define them under Admin → Taxonomy → Service lines.');
      return;
    }
    try {
      const body = {
        name: draft.name,
        description: draft.description,
        category: draft.category,
        defaultPriceCents: draft.defaultPriceCents,
        billingType: draft.billingType,
        recurringInterval: draft.recurringInterval,
        isAddon: draft.isAddon,
        parentServiceId: draft.parentServiceId,
        coaCode: draft.coaCode,
        tagIds: draft.tagIds,
      };
      if (draft.id) {
        const { tagIds: _, ...patch } = body;
        await api(`/api/staff/services/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        await api(`/api/staff/services/${draft.id}/tags`, {
          method: 'POST',
          body: JSON.stringify({ tagIds: draft.tagIds }),
        });
      } else {
        await api('/api/staff/services', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      setDraft(null);
      await loadServices();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'save_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/services/${id}/archive`, { method: 'POST', body: '{}' });
      await loadServices();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  async function restore(id: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/services/${id}/restore`, { method: 'POST', body: '{}' });
      await loadServices();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'restore_failed');
    }
  }

  function startEdit(svc: ServiceRow): void {
    setDraft({
      id: svc.id,
      name: svc.name,
      description: svc.description,
      category: svc.category,
      defaultPriceCents: svc.defaultPriceCents,
      billingType: svc.billingType,
      recurringInterval: svc.recurringInterval,
      isAddon: svc.isAddon,
      parentServiceId: svc.parentServiceId,
      coaCode: svc.coaCode,
      tagIds: svc.tags.map((t) => t.id),
    });
  }

  function toggleSelect(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Taxonomy categories first, then anything already in use on services
  // (legacy enum values keep working until re-categorized).
  const categoryOptions = useMemo(() => {
    const set = new Set<string>(taxonomyCategories);
    for (const s of services) set.add(s.category);
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [taxonomyCategories, services]);

  const filteredByQuery = useMemo(() => {
    // Server-side filter is the source of truth — search is client-side
    // only for instant feel; the actual list reflects whatever the
    // server returned.
    if (!filterQuery.trim()) return services;
    const q = filterQuery.trim().toLowerCase();
    return services.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
    );
  }, [services, filterQuery]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <SectionHeading
        title="Services catalog"
        description="Define the services your firm bills for. Used by proposals + engagements."
      />

      <TagsPanel tags={tags} onChange={loadTags} />

      <TemplateLibraryPanel area="services" onImported={() => void loadServices()} />

      <Card title="Services">
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 12,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div style={{ width: 160 }}>
            <Combobox
              ariaLabel="Category"
              value={filterCategory}
              onChange={(v) => setFilterCategory(v ?? '')}
              options={[
                { value: '', label: 'All categories' },
                ...categoryOptions.map((c) => ({ value: c, label: c })),
              ]}
            />
          </div>
          <div style={{ width: 200 }}>
            <Combobox
              ariaLabel="Tag"
              value={filterTagId}
              onChange={(v) => setFilterTagId(v ?? '')}
              options={[
                { value: '', label: 'All tags' },
                ...tags.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          </div>
          <Input
            placeholder="Search by name…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            style={{ minWidth: 200 }}
          />
          <label style={{ fontSize: 12, color: tokens.color.textMuted }}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Include archived
          </label>
          <div style={{ flex: 1 }} />
          {selectedIds.size > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setBulkOpen(true)}>
              Bulk price… ({selectedIds.size})
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => setDraft({ ...emptyDraft(), category: categoryOptions[0] ?? '' })}
          >
            New service
          </Button>
        </div>

        {err && <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }}>{err}</p>}

        {!loaded ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
        ) : filteredByQuery.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
            No services match. Create the first one with “New service.”
          </p>
        ) : (
          <Table<ServiceRow>
            columns={[
              {
                key: 'select',
                header: '',
                render: (r) => (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleSelect(r.id)}
                    aria-label={`Select ${r.name}`}
                  />
                ),
              },
              { key: 'name', header: 'Name', render: (r) => r.name },
              {
                key: 'cat',
                header: 'Category',
                render: (r) => <Pill>{r.category}</Pill>,
              },
              {
                key: 'bill',
                header: 'Billing',
                render: (r) =>
                  r.billingType === 'RECURRING'
                    ? `${r.recurringInterval ?? '—'}`
                    : r.billingType.replace(/_/g, ' ').toLowerCase(),
              },
              {
                key: 'price',
                header: 'Default price',
                align: 'right',
                render: (r) => dollarsFromCents(r.defaultPriceCents),
              },
              {
                key: 'tags',
                header: 'Tags',
                render: (r) =>
                  r.tags.length === 0 ? (
                    <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>—</span>
                  ) : (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.tags.map((t) => (
                        <Pill key={t.id}>{t.name}</Pill>
                      ))}
                    </div>
                  ),
              },
              {
                key: 'st',
                header: 'Status',
                render: (r) =>
                  r.archivedAt ? (
                    <Pill tone="warning">Archived</Pill>
                  ) : (
                    <Pill tone="success">Active</Pill>
                  ),
              },
              {
                key: 'act',
                header: '',
                align: 'right',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="ghost" onClick={() => startEdit(r)}>
                      Edit
                    </Button>
                    {r.archivedAt ? (
                      <Button size="sm" variant="ghost" onClick={() => void restore(r.id)}>
                        Restore
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void archive(r.id)}>
                        Archive
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={filteredByQuery}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      {draft && (
        <ServiceEditor
          draft={draft}
          tags={tags}
          categories={categoryOptions}
          allServices={services}
          onChange={setDraft}
          onSave={() => void saveDraft()}
          onCancel={() => {
            setDraft(null);
            setErr(null);
          }}
        />
      )}

      {bulkOpen && (
        <BulkPriceDialog
          count={selectedIds.size}
          onCancel={() => setBulkOpen(false)}
          onApply={async (mode, value) => {
            setErr(null);
            try {
              const body =
                mode === 'percent'
                  ? { serviceIds: Array.from(selectedIds), deltaPercentBps: value }
                  : { serviceIds: Array.from(selectedIds), deltaFlatCents: value };
              await api('/api/staff/services/bulk-price', {
                method: 'POST',
                body: JSON.stringify(body),
              });
              setBulkOpen(false);
              setSelectedIds(new Set());
              await loadServices();
            } catch (e) {
              setErr(e instanceof Error ? e.message : 'bulk_failed');
              setBulkOpen(false);
            }
          }}
        />
      )}
    </div>
  );
}

function TagsPanel({
  tags,
  onChange,
}: {
  tags: TagRow[];
  onChange: () => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [err, setErr] = useState<string | null>(null);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    try {
      await api('/api/staff/service-tags', {
        method: 'POST',
        body: JSON.stringify({ name, color }),
      });
      setName('');
      await onChange();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    }
  }

  async function rename(id: string, currentName: string): Promise<void> {
    const next = prompt('New tag name:', currentName);
    if (!next || next.trim() === currentName) return;
    try {
      await api(`/api/staff/service-tags/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next.trim() }),
      });
      await onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'rename_failed');
    }
  }

  async function remove(id: string, n: string): Promise<void> {
    if (!confirm(`Delete tag "${n}"? Services tagged with it will become untagged.`)) return;
    try {
      await api(`/api/staff/service-tags/${id}`, { method: 'DELETE' });
      await onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete_failed');
    }
  }

  return (
    <Card title="Tags">
      <form
        onSubmit={create}
        style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}
      >
        <Input
          placeholder="Tag name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          style={{ width: 36, height: 32, padding: 0, border: 0, cursor: 'pointer' }}
          aria-label="Tag color"
        />
        <Button type="submit" size="sm">
          Add tag
        </Button>
      </form>
      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}
      {tags.length === 0 ? (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          No tags yet. Add one above to start grouping services.
        </p>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {tags.map((t) => (
            <span
              key={t.id}
              style={{
                display: 'inline-flex',
                gap: 6,
                alignItems: 'center',
                padding: '4px 8px',
                borderRadius: tokens.radius.sm,
                background: tokens.color.bg,
                border: `1px solid ${tokens.color.border}`,
                fontSize: 12,
              }}
            >
              {t.color && (
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: t.color,
                  }}
                />
              )}
              <span>{t.name}</span>
              <button
                type="button"
                onClick={() => void rename(t.id, t.name)}
                style={{
                  background: 'transparent',
                  border: 0,
                  color: tokens.color.textMuted,
                  cursor: 'pointer',
                  fontSize: 11,
                }}
                aria-label={`Rename ${t.name}`}
              >
                rename
              </button>
              <button
                type="button"
                onClick={() => void remove(t.id, t.name)}
                style={{
                  background: 'transparent',
                  border: 0,
                  color: tokens.color.danger,
                  cursor: 'pointer',
                  fontSize: 11,
                }}
                aria-label={`Delete ${t.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function ServiceEditor({
  draft,
  tags,
  categories,
  allServices,
  onChange,
  onSave,
  onCancel,
}: {
  draft: DraftService;
  tags: TagRow[];
  categories: string[];
  allServices: ServiceRow[];
  onChange: (d: DraftService) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const isEdit = Boolean(draft.id);
  const needsInterval =
    draft.billingType === 'RECURRING' || draft.billingType === 'SPLIT_DEPOSIT_RECURRING';
  const priceDollars = (draft.defaultPriceCents / 100).toFixed(2);

  return (
    <Card title={isEdit ? 'Edit service' : 'New service'}>
      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        }}
      >
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Name</span>
          <Input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="e.g. Monthly Bookkeeping"
            required
          />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Category</span>
          <Combobox
            ariaLabel="Category"
            value={draft.category}
            onChange={(v) => onChange({ ...draft, category: v ?? '' })}
            options={[
              // Keep the current value selectable even if its taxonomy
              // category was renamed since this service was created.
              ...(draft.category && !categories.includes(draft.category)
                ? [{ value: draft.category, label: draft.category }]
                : []),
              ...categories.map((c) => ({ value: c, label: c })),
            ]}
          />
          {categories.length === 0 && (
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
              No categories yet — add service lines under Admin → Taxonomy.
            </span>
          )}
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Billing type</span>
          <Combobox
            ariaLabel="Billing type"
            value={draft.billingType}
            onChange={(v) => {
              const next = (v as BillingType) ?? 'ONE_TIME';
              const willNeed = next === 'RECURRING' || next === 'SPLIT_DEPOSIT_RECURRING';
              onChange({
                ...draft,
                billingType: next,
                recurringInterval: willNeed ? (draft.recurringInterval ?? 'MONTHLY') : null,
              });
            }}
            options={BILLING_TYPES.map((b) => ({
              value: b,
              label: b.replace(/_/g, ' ').toLowerCase(),
            }))}
          />
        </div>
        {needsInterval && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Recurring interval</span>
            <Combobox
              ariaLabel="Recurring interval"
              value={draft.recurringInterval ?? 'MONTHLY'}
              onChange={(v) =>
                onChange({ ...draft, recurringInterval: (v as Interval) ?? 'MONTHLY' })
              }
              options={INTERVALS.map((i) => ({ value: i, label: i.toLowerCase() }))}
            />
          </div>
        )}
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Default price (USD)</span>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={priceDollars}
            onChange={(e) => {
              const cents = centsFromDollars(e.target.value);
              if (cents != null) onChange({ ...draft, defaultPriceCents: cents });
            }}
          />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>COA code</span>
          <Input
            value={draft.coaCode ?? ''}
            onChange={(e) =>
              onChange({ ...draft, coaCode: e.target.value.trim() === '' ? null : e.target.value })
            }
            placeholder="optional"
          />
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Add-on of (parent)</span>
          <Combobox
            ariaLabel="Parent service"
            value={draft.parentServiceId ?? ''}
            onChange={(v) =>
              onChange({
                ...draft,
                parentServiceId: v && v !== '' ? v : null,
                isAddon: Boolean(v && v !== ''),
              })
            }
            options={[
              { value: '', label: '— Top-level —' },
              ...allServices
                .filter((s) => s.id !== draft.id)
                .map((s) => ({ value: s.id, label: s.name })),
            ]}
          />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 4, marginTop: 12 }}>
        <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Description (Markdown)</span>
        <textarea
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          rows={4}
          style={{
            fontFamily: 'inherit',
            fontSize: 13,
            padding: 8,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            background: tokens.color.surface,
            color: tokens.color.text,
          }}
        />
      </div>

      {tags.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 6 }}>Tags</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {tags.map((t) => {
              const selected = draft.tagIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...draft,
                      tagIds: selected
                        ? draft.tagIds.filter((x) => x !== t.id)
                        : [...draft.tagIds, t.id],
                    })
                  }
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    borderRadius: tokens.radius.sm,
                    border: `1px solid ${selected ? tokens.color.accent : tokens.color.border}`,
                    background: selected ? tokens.color.accentMuted : tokens.color.surface,
                    color: selected ? tokens.color.accent : tokens.color.text,
                    cursor: 'pointer',
                  }}
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onSave} disabled={!draft.name.trim()}>
          {isEdit ? 'Save changes' : 'Create service'}
        </Button>
      </div>
    </Card>
  );
}

function BulkPriceDialog({
  count,
  onCancel,
  onApply,
}: {
  count: number;
  onCancel: () => void;
  onApply: (mode: 'percent' | 'flat', value: number) => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState<'percent' | 'flat'>('percent');
  const [percent, setPercent] = useState('5'); // percent
  const [flat, setFlat] = useState('1.00'); // dollars

  function submit(): void {
    if (mode === 'percent') {
      const p = Number(percent);
      if (!Number.isFinite(p)) return;
      const bps = Math.round(p * 100);
      void onApply('percent', bps);
    } else {
      const cents = centsFromDollarsSigned(flat);
      if (cents == null) return;
      void onApply('flat', cents);
    }
  }

  return (
    <Card title={`Bulk price — ${count} service(s)`}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            name="mode"
            checked={mode === 'percent'}
            onChange={() => setMode('percent')}
            style={{ marginRight: 6 }}
          />
          Percent delta
        </label>
        <label style={{ fontSize: 13 }}>
          <input
            type="radio"
            name="mode"
            checked={mode === 'flat'}
            onChange={() => setMode('flat')}
            style={{ marginRight: 6 }}
          />
          Flat delta
        </label>
      </div>
      {mode === 'percent' ? (
        <div style={{ display: 'grid', gap: 4, maxWidth: 240 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Apply this percent to current price (e.g. 5 = +5%, -5 = -5%)
          </span>
          <Input
            type="number"
            step="0.01"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 4, maxWidth: 240 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Add this amount to current price (USD, negative reduces)
          </span>
          <Input type="number" step="0.01" value={flat} onChange={(e) => setFlat(e.target.value)} />
        </div>
      )}
      <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 12 }}>
        Prices are floored at $0 — they cannot go negative.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={submit}>Apply</Button>
      </div>
    </Card>
  );
}

function centsFromDollarsSigned(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
