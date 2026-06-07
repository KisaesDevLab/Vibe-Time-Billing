// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P03 — Packages admin page (ADDENDUM-PROPOSAL-MODULE.md §P03).
//
// Layout:
//   • "Add tier" form at the top — name + tier label + position
//   • Existing packages grouped by name (each group becomes a
//     side-by-side preview row of its tiers)
//   • Selecting one tier opens an editor below: pick services from
//     the catalog, set override price, toggle included/add-on.
//   • Duplicate / archive / restore controls per tier card.
//
// Math: included total = Σ (override OR service.default_price) for
// every entry with included=true.

import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Button, Card, Input, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { TemplateLibraryPanel } from './TemplateLibraryPanel';

interface PackageRow {
  id: string;
  name: string;
  tierLabel: string;
  position: number;
  description: string;
  archivedAt: string | null;
  totalIncludedCents: number;
  includedServiceCount: number;
}

interface ServiceRow {
  id: string;
  name: string;
  category: string;
  billingType: string;
  recurringInterval: string | null;
  defaultPriceCents: number;
}

interface PackageEntry {
  id?: string;
  serviceId: string;
  serviceName: string;
  serviceCategory: string;
  serviceBillingType: string;
  serviceRecurringInterval: string | null;
  serviceDefaultPriceCents: number;
  overridePriceCents: number | null;
  included: boolean;
  sequence: number;
}

interface PackageDetail {
  package: PackageRow;
  entries: PackageEntry[];
}

function dollars(c: number): string {
  return (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function PackagesPage(): JSX.Element {
  const [groups, setGroups] = useState<Record<string, PackageRow[]>>({});
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [draftEntries, setDraftEntries] = useState<PackageEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [savingEntries, setSavingEntries] = useState(false);

  // Header form
  const [newName, setNewName] = useState('');
  const [newTierLabel, setNewTierLabel] = useState('Bronze');
  const [newPosition, setNewPosition] = useState(0);

  async function loadGroups(): Promise<void> {
    const params = new URLSearchParams({ groupByName: 'true' });
    if (includeArchived) params.set('includeArchived', 'true');
    const r = await api<{ groups: Record<string, PackageRow[]> }>(
      `/api/staff/packages?${params.toString()}`,
    );
    setGroups(r.groups ?? {});
  }

  async function loadServices(): Promise<void> {
    const r = await api<{ items: ServiceRow[] }>('/api/staff/services');
    setServices(r.items ?? []);
  }

  async function loadDetail(id: string): Promise<void> {
    const r = await api<PackageDetail>(`/api/staff/packages/${id}`);
    setDetail(r);
    setDraftEntries(r.entries);
  }

  useEffect(() => {
    void loadServices();
  }, []);

  useEffect(() => {
    void loadGroups().catch((e) => setErr(e instanceof Error ? e.message : 'load_failed'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeArchived]);

  useEffect(() => {
    if (selectedId) {
      void loadDetail(selectedId).catch((e) =>
        setErr(e instanceof Error ? e.message : 'detail_failed'),
      );
    } else {
      setDetail(null);
      setDraftEntries([]);
    }
  }, [selectedId]);

  async function createPackage(e: FormEvent): Promise<void> {
    e.preventDefault();
    setErr(null);
    try {
      await api('/api/staff/packages', {
        method: 'POST',
        body: JSON.stringify({
          name: newName,
          tierLabel: newTierLabel,
          position: newPosition,
        }),
      });
      setNewName('');
      setNewTierLabel('Bronze');
      setNewPosition(0);
      await loadGroups();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'create_failed');
    }
  }

  async function archive(id: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/packages/${id}/archive`, { method: 'POST', body: '{}' });
      if (id === selectedId) setSelectedId(null);
      await loadGroups();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  async function restore(id: string): Promise<void> {
    setErr(null);
    try {
      await api(`/api/staff/packages/${id}/restore`, { method: 'POST', body: '{}' });
      await loadGroups();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'restore_failed');
    }
  }

  async function duplicate(id: string, name: string, tierLabel: string): Promise<void> {
    setErr(null);
    const newTier = prompt(`Duplicate "${name} / ${tierLabel}" — new tier label?`, 'Silver');
    if (!newTier) return;
    try {
      const r = await api<{ id: string }>(`/api/staff/packages/${id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ tierLabel: newTier }),
      });
      await loadGroups();
      setSelectedId(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'duplicate_failed');
    }
  }

  async function saveEntries(): Promise<void> {
    if (!selectedId) return;
    setSavingEntries(true);
    setErr(null);
    try {
      await api(`/api/staff/packages/${selectedId}/services`, {
        method: 'POST',
        body: JSON.stringify({
          entries: draftEntries.map((e, i) => ({
            serviceId: e.serviceId,
            overridePriceCents: e.overridePriceCents,
            included: e.included,
            sequence: i,
          })),
        }),
      });
      await loadDetail(selectedId);
      await loadGroups();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'save_failed');
    } finally {
      setSavingEntries(false);
    }
  }

  function addEntry(serviceId: string): void {
    const svc = services.find((s) => s.id === serviceId);
    if (!svc) return;
    if (draftEntries.some((e) => e.serviceId === serviceId)) return;
    setDraftEntries((prev) => [
      ...prev,
      {
        serviceId,
        serviceName: svc.name,
        serviceCategory: svc.category,
        serviceBillingType: svc.billingType,
        serviceRecurringInterval: svc.recurringInterval,
        serviceDefaultPriceCents: svc.defaultPriceCents,
        overridePriceCents: null,
        included: true,
        sequence: prev.length,
      },
    ]);
  }

  function removeEntry(serviceId: string): void {
    setDraftEntries((prev) => prev.filter((e) => e.serviceId !== serviceId));
  }

  function updateEntry(serviceId: string, patch: Partial<PackageEntry>): void {
    setDraftEntries((prev) =>
      prev.map((e) => (e.serviceId === serviceId ? { ...e, ...patch } : e)),
    );
  }

  const draftIncludedTotal = useMemo(
    () =>
      draftEntries.reduce(
        (sum, e) => (e.included ? sum + (e.overridePriceCents ?? e.serviceDefaultPriceCents) : sum),
        0,
      ),
    [draftEntries],
  );

  const draftDirty = useMemo(() => {
    if (!detail) return false;
    if (detail.entries.length !== draftEntries.length) return true;
    return draftEntries.some((e, i) => {
      const prior = detail.entries[i];
      if (!prior) return true;
      return (
        prior.serviceId !== e.serviceId ||
        prior.included !== e.included ||
        (prior.overridePriceCents ?? null) !== (e.overridePriceCents ?? null)
      );
    });
  }, [detail, draftEntries]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1300 }}>
      <SectionHeading
        title="Packages"
        description="Bundle services into reusable 3-tier offerings (e.g. Bronze / Silver / Gold). Proposals offer packages and the client picks one."
      />

      <TemplateLibraryPanel
        area="packages"
        onImported={() => {
          void loadGroups();
          void loadServices();
        }}
      />

      <Card title="Add tier">
        <form
          onSubmit={createPackage}
          style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <Input
            placeholder="Package name (e.g. Small Business Tax)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            style={{ minWidth: 260 }}
          />
          <Input
            placeholder="Tier label"
            value={newTierLabel}
            onChange={(e) => setNewTierLabel(e.target.value)}
            required
            style={{ width: 140 }}
          />
          <Input
            type="number"
            min="0"
            placeholder="Position"
            value={String(newPosition)}
            onChange={(e) => setNewPosition(Number(e.target.value) || 0)}
            style={{ width: 100 }}
          />
          <Button type="submit" size="sm">
            Add tier
          </Button>
          <label style={{ fontSize: 12, color: tokens.color.textMuted, marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Include archived
          </label>
        </form>
        <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 8 }}>
          To build a three-tier offering, create three rows with the same name and different tier
          labels — they group together in the preview below.
        </p>
      </Card>

      {err && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{err}</p>}

      {Object.keys(groups).length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No packages yet. Add your first tier above.
        </p>
      ) : (
        Object.entries(groups).map(([name, tiers]) => (
          <Card key={name} title={name}>
            <div
              style={{
                display: 'grid',
                gap: 12,
                gridTemplateColumns: `repeat(${Math.min(tiers.length, 3)}, 1fr)`,
              }}
            >
              {tiers.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  style={{
                    textAlign: 'left',
                    padding: tokens.space.md,
                    border: `1px solid ${
                      t.id === selectedId ? tokens.color.accent : tokens.color.border
                    }`,
                    borderRadius: tokens.radius.sm,
                    background:
                      t.id === selectedId ? tokens.color.accentMuted : tokens.color.surface,
                    cursor: 'pointer',
                    display: 'grid',
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                    }}
                  >
                    <strong>{t.tierLabel}</strong>
                    {t.archivedAt && <Pill tone="warning">Archived</Pill>}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 600 }}>
                    {dollars(Number(t.totalIncludedCents))}
                  </div>
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {t.includedServiceCount} included service
                    {t.includedServiceCount === 1 ? '' : 's'}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        void duplicate(t.id, name, t.tierLabel);
                      }}
                    >
                      Duplicate
                    </Button>
                    {t.archivedAt ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void restore(t.id);
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
                          void archive(t.id);
                        }}
                      >
                        Archive
                      </Button>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </Card>
        ))
      )}

      {detail && (
        <Card
          title={`Edit services — ${detail.package.name} / ${detail.package.tierLabel}`}
          action={
            <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
              Close
            </Button>
          }
        >
          <PackageEntryEditor
            entries={draftEntries}
            services={services}
            onAdd={addEntry}
            onRemove={removeEntry}
            onUpdate={updateEntry}
          />
          <div
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              marginTop: 12,
              borderTop: `1px solid ${tokens.color.border}`,
              paddingTop: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Tier total (included)
              </div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>{dollars(draftIncludedTotal)}</div>
            </div>
            <div style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              disabled={!draftDirty}
              onClick={() => {
                if (detail) setDraftEntries(detail.entries);
              }}
            >
              Revert
            </Button>
            <Button
              size="sm"
              onClick={() => void saveEntries()}
              disabled={!draftDirty || savingEntries}
            >
              {savingEntries ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function PackageEntryEditor({
  entries,
  services,
  onAdd,
  onRemove,
  onUpdate,
}: {
  entries: PackageEntry[];
  services: ServiceRow[];
  onAdd: (serviceId: string) => void;
  onRemove: (serviceId: string) => void;
  onUpdate: (serviceId: string, patch: Partial<PackageEntry>) => void;
}): JSX.Element {
  const candidates = services.filter((s) => !entries.some((e) => e.serviceId === s.id));
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {entries.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No services in this tier yet. Add some from the catalog below.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: tokens.color.textMuted, fontSize: 11 }}>
              <th style={{ padding: 6 }}>Service</th>
              <th style={{ padding: 6 }}>Category</th>
              <th style={{ padding: 6, textAlign: 'right' }}>Default</th>
              <th style={{ padding: 6, textAlign: 'right' }}>Override</th>
              <th style={{ padding: 6, textAlign: 'center' }}>Included?</th>
              <th style={{ padding: 6 }}></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.serviceId} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                <td style={{ padding: 6 }}>{e.serviceName}</td>
                <td style={{ padding: 6 }}>
                  <Pill>{e.serviceCategory}</Pill>
                </td>
                <td style={{ padding: 6, textAlign: 'right', color: tokens.color.textMuted }}>
                  {dollars(Number(e.serviceDefaultPriceCents))}
                </td>
                <td style={{ padding: 6, textAlign: 'right' }}>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="—"
                    value={
                      e.overridePriceCents != null ? (e.overridePriceCents / 100).toFixed(2) : ''
                    }
                    onChange={(ev) => {
                      const v = ev.target.value.trim();
                      if (v === '') onUpdate(e.serviceId, { overridePriceCents: null });
                      else {
                        const n = Number(v);
                        if (Number.isFinite(n) && n >= 0) {
                          onUpdate(e.serviceId, { overridePriceCents: Math.round(n * 100) });
                        }
                      }
                    }}
                    style={{ width: 110, textAlign: 'right' }}
                  />
                </td>
                <td style={{ padding: 6, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={e.included}
                    onChange={(ev) => onUpdate(e.serviceId, { included: ev.target.checked })}
                    aria-label={`Include ${e.serviceName}`}
                  />
                </td>
                <td style={{ padding: 6 }}>
                  <Button size="sm" variant="ghost" onClick={() => onRemove(e.serviceId)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {candidates.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            marginTop: 8,
            paddingTop: 8,
            borderTop: `1px solid ${tokens.color.border}`,
          }}
        >
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Add service:</span>
          <select
            onChange={(e) => {
              if (e.target.value) {
                onAdd(e.target.value);
                e.target.value = '';
              }
            }}
            style={{
              padding: 6,
              fontSize: 13,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
              color: tokens.color.text,
            }}
            aria-label="Add service to package"
          >
            <option value="">— pick a service —</option>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {dollars(Number(s.defaultPriceCents))} ({s.category})
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
