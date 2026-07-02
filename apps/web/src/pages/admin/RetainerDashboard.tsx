/* eslint-disable jsx-a11y/label-has-associated-control -- labels and controls are siblings inside grid containers; revisit with htmlFor/id pairs in a polish pass */
// SPDX-License-Identifier: Elastic-2.0
//
// R5 — Partner retainer dashboard. KPI strip + retainer table.
// Tier-config + firm-settings live at /admin/retainer-tiers; this page
// is the operational view.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Button, Card, ColumnFilter, Pill, Stat, Table, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { selectRows, useColumnView } from '../../lib/column-view';
import { useClientPage } from '../../lib/use-paged-list';
import { TableSearch } from '../../components/TableSearch';

function fmtCents(c: number | null | undefined): string {
  if (c == null) return '—';
  return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Kpis {
  activeCount: number;
  tier1Active: number;
  tier2Active: number;
  hoursSold12mo: number;
  hoursConsumed12mo: number;
  expiring90d: number;
  openOffers: number;
  purchased90d: number;
  declined90d: number;
  expired90d: number;
}

interface RetainerRow {
  id: string;
  clientId: string;
  engagementId: string;
  tier: 'TIER_1' | 'TIER_2';
  returnType: string;
  taxYear: number;
  name: string;
  hoursPurchased: string;
  hoursConsumed: string;
  expiryDate: string;
  status: 'active' | 'exhausted' | 'expired' | 'void' | 'paused' | 'pending_payment';
  priceCents: number;
}

interface OfferRow {
  id: string;
  clientId: string;
  clientName: string | null;
  returnType: string;
  taxYear: number;
  status: 'pending' | 'pending_payment' | 'purchased' | 'declined' | 'expired';
  tier1PriceCents: number;
  tier2PriceCents: number;
  purchasedTier: 'TIER_1' | 'TIER_2' | null;
  purchasedInvoiceId: string | null;
  offerExpiresAt: string;
  createdAt: string;
  portalUrl: string | null;
}

interface TierConfigOption {
  id: string;
  returnType: string;
  tier: 'TIER_1' | 'TIER_2';
  name: string;
  hours: number;
  baseFeeCents: number;
}

interface EngagementOption {
  id: string;
  name: string;
  clientName: string | null;
  hasRetainer: boolean;
}

const RETAINER_STATUS_VALUES = [
  { value: 'active', label: 'Active' },
  { value: 'exhausted', label: 'Exhausted' },
  { value: 'expired', label: 'Expired' },
  { value: 'void', label: 'Void' },
  { value: 'paused', label: 'Paused' },
  { value: 'pending_payment', label: 'Awaiting payment' },
];

const OFFER_STATUS_VALUES = [
  { value: 'pending', label: 'Pending' },
  { value: 'pending_payment', label: 'Awaiting payment' },
  { value: 'purchased', label: 'Purchased' },
  { value: 'declined', label: 'Declined' },
  { value: 'expired', label: 'Expired' },
];

export function RetainerDashboardPage(): JSX.Element {
  const navigate = useNavigate();
  const view = useColumnView('vibe.retainers.view', { sortCol: 'expires', sortDir: 'asc' });
  const offerView = useColumnView('vibe.retainerOffers.view', {
    sortCol: 'created',
    sortDir: 'desc',
  });
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [items, setItems] = useState<RetainerRow[]>([]);
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [offerMsg, setOfferMsg] = useState<string | null>(null);
  const [sellingId, setSellingId] = useState<string | null>(null);
  const [emailingId, setEmailingId] = useState<string | null>(null);
  const [voidId, setVoidId] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  // R7 — manual-create state
  const [showCreate, setShowCreate] = useState(false);
  const [createEngagementId, setCreateEngagementId] = useState('');
  const [createTierConfigId, setCreateTierConfigId] = useState('');
  const [createHours, setCreateHours] = useState<number | ''>('');
  const [createPriceCents, setCreatePriceCents] = useState<number | ''>('');
  const [createNotes, setCreateNotes] = useState('');
  // 0091 — billClient=true triggers the firm-initiated billing flow.
  // Default true so the dashboard's "Create" path matches the common
  // intent ("I want to bill the client a retainer"). Flip to record-only
  // when payment was already collected.
  const [billClient, setBillClient] = useState(true);
  const [tierConfigs, setTierConfigs] = useState<TierConfigOption[]>([]);
  const [engagements, setEngagements] = useState<EngagementOption[]>([]);

  async function load(): Promise<void> {
    try {
      const [k, list, offerList] = await Promise.all([
        api<{ kpis: Kpis | null }>('/api/staff/retainers/admin/kpis'),
        api<{ items: RetainerRow[] }>('/api/staff/retainers'),
        api<{ items: OfferRow[] }>('/api/staff/retainers/offers'),
      ]);
      setKpis(k.kpis);
      setItems(list.items ?? []);
      setOffers(offerList.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
    }
  }

  // Staff "in-office" select: sell a tier on the client's behalf so the
  // retainer purchase invoice exists for immediate counter payment.
  async function sellTier(offer: OfferRow, tier: 'TIER_1' | 'TIER_2'): Promise<void> {
    const price = tier === 'TIER_1' ? offer.tier1PriceCents : offer.tier2PriceCents;
    if (
      !confirm(
        `Sell ${tier === 'TIER_1' ? 'Tier 1' : 'Tier 2'} (${fmtCents(price)}) to ${offer.clientName ?? 'this client'}? This creates the retainer invoice for counter payment.`,
      )
    )
      return;
    setError(null);
    setOfferMsg(null);
    setSellingId(offer.id);
    try {
      const r = await api<{ invoiceId: string; invoiceNumber: string; priceCents: number }>(
        `/api/staff/retainers/offers/${offer.id}/select`,
        { method: 'POST', body: JSON.stringify({ tier }) },
      );
      setOfferMsg(`Created retainer invoice ${r.invoiceNumber} — opening it for payment…`);
      await load();
      navigate(`/invoices/${r.invoiceId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'select failed');
    } finally {
      setSellingId(null);
    }
  }

  async function copyLink(offer: OfferRow): Promise<void> {
    if (!offer.portalUrl) return;
    try {
      await navigator.clipboard.writeText(offer.portalUrl);
      setOfferMsg('Client offer link copied to clipboard.');
    } catch {
      setOfferMsg(offer.portalUrl);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function performVoid(): Promise<void> {
    if (!voidId) return;
    setError(null);
    try {
      await api(`/api/staff/retainers/${voidId}/void`, {
        method: 'POST',
        body: JSON.stringify({ reason: voidReason }),
      });
      setVoidId(null);
      setVoidReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'void failed');
    }
  }

  async function pauseRetainer(id: string): Promise<void> {
    setError(null);
    try {
      await api(`/api/staff/retainers/${id}/pause`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'pause failed');
    }
  }

  async function resumeRetainer(id: string): Promise<void> {
    setError(null);
    try {
      await api(`/api/staff/retainers/${id}/resume`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'resume failed');
    }
  }

  async function openCreate(): Promise<void> {
    setError(null);
    setShowCreate(true);
    // Lazy-load the dropdowns when the form opens.
    if (tierConfigs.length === 0 || engagements.length === 0) {
      try {
        // Load all tier configs (one call per return type — 6 total).
        const types = ['1040', '1065', '1120', '1120S', '1041', '990'] as const;
        const tcLists = await Promise.all(
          types.map((rt) =>
            api<{
              returnType: string;
              tier1: TierConfigOption | null;
              tier2: TierConfigOption | null;
            }>(`/api/staff/admin/retainer/tier-configs?returnType=${rt}`),
          ),
        );
        const flat: TierConfigOption[] = [];
        for (const r of tcLists) {
          if (r.tier1) flat.push({ ...r.tier1, returnType: r.returnType, tier: 'TIER_1' });
          if (r.tier2) flat.push({ ...r.tier2, returnType: r.returnType, tier: 'TIER_2' });
        }
        setTierConfigs(flat);
        const engResp = await api<{ items: EngagementOption[] }>('/api/staff/engagements');
        setEngagements(engResp.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'options load failed');
      }
    }
  }

  async function performCreate(): Promise<void> {
    if (!createEngagementId || !createTierConfigId) return;
    setError(null);
    try {
      const body: Record<string, unknown> = {
        engagementId: createEngagementId,
        tierConfigId: createTierConfigId,
      };
      if (createHours !== '') body['hoursPurchased'] = Number(createHours);
      if (createPriceCents !== '') body['priceCents'] = Number(createPriceCents);
      if (createNotes) body['notes'] = createNotes;
      body['billClient'] = billClient;
      await api('/api/staff/retainers/manual', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setShowCreate(false);
      setCreateEngagementId('');
      setCreateTierConfigId('');
      setCreateHours('');
      setCreatePriceCents('');
      setCreateNotes('');
      setBillClient(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    }
  }

  // Per-column filter value lists for the Retainers table.
  const typeValues = useMemo(() => {
    const seen = new Set<string>();
    for (const r of items) seen.add(`${r.returnType} (${r.tier})`);
    return Array.from(seen)
      .sort((a, b) => a.localeCompare(b))
      .map((v) => ({ value: v, label: v }));
  }, [items]);

  const visible = useMemo(
    () =>
      selectRows(items, view, {
        filters: {
          type: (r) => `${r.returnType} (${r.tier})`,
          status: (r) => r.status,
        },
        sortValues: {
          name: (r) => r.name,
          type: (r) => r.returnType,
          hours: (r) => Number(r.hoursConsumed),
          expires: (r) => r.expiryDate,
          status: (r) => r.status,
        },
        searchText: (r) => `${r.name} ${r.returnType} ${r.tier} ${r.status}`,
      }),
    [items, view],
  );

  const { paged, pagination } = useClientPage(visible);

  const visibleOffers = useMemo(
    () =>
      selectRows(offers, offerView, {
        filters: { status: (o) => o.status },
        sortValues: {
          client: (o) => o.clientName ?? '',
          return: (o) => `${o.returnType} ${o.taxYear}`,
          tiers: (o) => o.tier1PriceCents,
          status: (o) => o.status,
          expires: (o) => o.offerExpiresAt,
          created: (o) => o.createdAt,
        },
        searchText: (o) => `${o.clientName ?? ''} ${o.returnType} ${o.taxYear} ${o.status}`,
      }),
    [offers, offerView],
  );

  async function deleteOffer(offer: OfferRow): Promise<void> {
    if (!confirm(`Delete the pending retainer offer for ${offer.clientName ?? 'this client'}?`))
      return;
    setError(null);
    setOfferMsg(null);
    try {
      await api(`/api/staff/retainers/offers/${offer.id}`, { method: 'DELETE' });
      setOfferMsg('Offer deleted.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
    }
  }

  async function emailOffer(offer: OfferRow): Promise<void> {
    setError(null);
    setOfferMsg(null);
    setEmailingId(offer.id);
    try {
      const r = await api<{ to: string }>(`/api/staff/retainers/offers/${offer.id}/email`, {
        method: 'POST',
        body: '{}',
      });
      setOfferMsg(`Proposal emailed to ${r.to}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'email failed';
      setError(
        msg === 'no_primary_contact_email'
          ? 'No primary contact with an email on file for this client.'
          : msg === 'mail_not_configured'
            ? 'Email delivery is not configured on this appliance.'
            : `Email failed: ${msg}`,
      );
    } finally {
      setEmailingId(null);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <Card title="Retainer KPIs">
        {kpis ? (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
            }}
          >
            <Stat label="Active" value={kpis.activeCount} />
            <Stat label="Tier 1 active" value={kpis.tier1Active} />
            <Stat label="Tier 2 active" value={kpis.tier2Active} />
            <Stat label="Hours sold (12mo)" value={kpis.hoursSold12mo.toFixed(1)} />
            <Stat label="Hours consumed (12mo)" value={kpis.hoursConsumed12mo.toFixed(1)} />
            <Stat
              label="Utilization"
              value={
                kpis.hoursSold12mo > 0
                  ? `${Math.round((kpis.hoursConsumed12mo / kpis.hoursSold12mo) * 100)}%`
                  : '—'
              }
            />
            <Stat label="Expiring 90d" value={kpis.expiring90d} />
            <Stat label="Open offers" value={kpis.openOffers} />
            <Stat label="Purchased 90d" value={kpis.purchased90d} />
            <Stat label="Declined 90d" value={kpis.declined90d} />
            <Stat label="Expired 90d" value={kpis.expired90d} />
          </div>
        ) : (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        )}
      </Card>

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Retainers</span>
            {items.length > 0 && (
              <span style={{ fontSize: 13, color: tokens.color.textMuted, fontWeight: 400 }}>
                {visible.length === items.length
                  ? `${items.length} retainer${items.length === 1 ? '' : 's'}`
                  : `${visible.length} of ${items.length}`}
              </span>
            )}
          </span>
        }
        action={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            {view.anyFilterActive && (
              <button
                type="button"
                onClick={view.clearFilters}
                style={{
                  background: 'none',
                  border: 'none',
                  color: tokens.color.accent,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Clear filters
              </button>
            )}
            <Button type="button" onClick={() => void openCreate()}>
              Create retainer
            </Button>
          </span>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={view} placeholder="Search retainers…" />
        </div>
        {items.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No retainers yet.</p>
        ) : (
          <Table<RetainerRow>
            columns={[
              {
                key: 'name',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Name{' '}
                    <ColumnFilter
                      ariaLabel="Sort by name"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('name')}
                      onApply={(_, dir) => view.apply('name', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (r) => (
                  <Link to={`/admin/retainers/${r.id}`} style={{ color: tokens.color.accent }}>
                    {r.name}
                  </Link>
                ),
              },
              {
                key: 'rt',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Type{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort type"
                      values={typeValues}
                      selected={view.filterFor('type')}
                      sort={view.sortFor('type')}
                      searchable={false}
                      onApply={(sel, dir) => view.apply('type', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (r) => `${r.returnType} (${r.tier})`,
              },
              {
                key: 'hours',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Hours{' '}
                    <ColumnFilter
                      ariaLabel="Sort by hours"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('hours')}
                      onApply={(_, dir) => view.apply('hours', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (r) =>
                  `${Number(r.hoursConsumed).toFixed(2)} / ${Number(r.hoursPurchased).toFixed(2)}`,
              },
              {
                key: 'expires',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Expires{' '}
                    <ColumnFilter
                      ariaLabel="Sort by expiry date"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={view.sortFor('expires')}
                      onApply={(_, dir) => view.apply('expires', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (r) => new Date(r.expiryDate).toLocaleDateString(),
              },
              {
                key: 'status',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort status"
                      values={RETAINER_STATUS_VALUES}
                      selected={view.filterFor('status')}
                      sort={view.sortFor('status')}
                      searchable={false}
                      onApply={(sel, dir) => view.apply('status', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (r) => (
                  <Pill
                    tone={
                      r.status === 'active'
                        ? 'success'
                        : r.status === 'exhausted'
                          ? 'warning'
                          : r.status === 'paused'
                            ? 'accent'
                            : r.status === 'pending_payment'
                              ? 'warning'
                              : r.status === 'expired'
                                ? 'neutral'
                                : 'danger'
                    }
                  >
                    {r.status === 'pending_payment' ? 'awaiting payment' : r.status}
                  </Pill>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 4 }}>
                    {r.status === 'active' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void pauseRetainer(r.id)}
                      >
                        Pause
                      </Button>
                    )}
                    {r.status === 'paused' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void resumeRetainer(r.id)}
                      >
                        Resume
                      </Button>
                    )}
                    {Number(r.hoursConsumed) === 0 && r.status !== 'void' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setVoidId(r.id)}
                      >
                        Void
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={paged}
            pagination={pagination}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      <Card
        title="Retainer offers"
        action={
          offerView.anyFilterActive ? (
            <button
              type="button"
              onClick={offerView.clearFilters}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.color.accent,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          ) : undefined
        }
      >
        {offerMsg && (
          <p style={{ fontSize: 12, color: tokens.color.success, marginTop: 0 }}>{offerMsg}</p>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Proposal-style offers auto-created when a tax-prep invoice is billed. Email the
          client&apos;s primary contact the proposal, hand them a printable PDF or the portal link,
          or sell a tier in-office to generate the retainer invoice for counter payment.
        </p>
        <div style={{ marginBottom: 12 }}>
          <TableSearch view={offerView} placeholder="Search offers…" />
        </div>
        {offers.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No offers yet.</p>
        ) : (
          <Table<OfferRow>
            columns={[
              {
                key: 'client',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Client{' '}
                    <ColumnFilter
                      ariaLabel="Sort by client"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={offerView.sortFor('client')}
                      onApply={(_, dir) => offerView.apply('client', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (o) => o.clientName ?? '—',
              },
              {
                key: 'rt',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Return{' '}
                    <ColumnFilter
                      ariaLabel="Sort by return"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={offerView.sortFor('return')}
                      onApply={(_, dir) => offerView.apply('return', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (o) => `${o.returnType} ${o.taxYear}`,
              },
              {
                key: 'tiers',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Tier add-on{' '}
                    <ColumnFilter
                      ariaLabel="Sort by tier price"
                      values={[]}
                      selected={new Set()}
                      searchable={false}
                      sort={offerView.sortFor('tiers')}
                      onApply={(_, dir) => offerView.apply('tiers', new Set(), dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (o) => `${fmtCents(o.tier1PriceCents)} / ${fmtCents(o.tier2PriceCents)}`,
              },
              {
                key: 'status',
                header: (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    Status{' '}
                    <ColumnFilter
                      ariaLabel="Filter / sort status"
                      values={OFFER_STATUS_VALUES}
                      selected={offerView.filterFor('status')}
                      sort={offerView.sortFor('status')}
                      searchable={false}
                      onApply={(sel, dir) => offerView.apply('status', sel, dir)}
                    />
                  </span>
                ) as unknown as string,
                render: (o) => (
                  <Pill
                    tone={
                      o.status === 'purchased'
                        ? 'success'
                        : o.status === 'pending'
                          ? 'accent'
                          : o.status === 'pending_payment'
                            ? 'warning'
                            : 'neutral'
                    }
                  >
                    {o.status === 'pending_payment'
                      ? 'awaiting payment'
                      : o.purchasedTier && o.status === 'purchased'
                        ? `purchased (${o.purchasedTier === 'TIER_1' ? 'T1' : 'T2'})`
                        : o.status}
                  </Pill>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (o) => (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        window.open(`/api/staff/retainers/offers/${o.id}/print.html`, '_blank')
                      }
                    >
                      Proposal
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        window.open(`/api/staff/retainers/offers/${o.id}/print.pdf`, '_blank')
                      }
                    >
                      PDF
                    </Button>
                    {o.portalUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void copyLink(o)}
                      >
                        Copy link
                      </Button>
                    )}
                    {o.status === 'pending' && (
                      <>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={emailingId === o.id}
                          onClick={() => void emailOffer(o)}
                        >
                          {emailingId === o.id ? 'Emailing…' : 'Email'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={sellingId === o.id}
                          onClick={() => void sellTier(o, 'TIER_1')}
                        >
                          Sell T1
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={sellingId === o.id}
                          onClick={() => void sellTier(o, 'TIER_2')}
                        >
                          Sell T2
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          onClick={() => void deleteOffer(o)}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                    {o.status === 'pending_payment' && o.purchasedInvoiceId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/invoices/${o.purchasedInvoiceId}`)}
                      >
                        Invoice
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
            rows={visibleOffers}
            rowKey={(o) => o.id}
            empty="No offers match the current filters."
          />
        )}
      </Card>

      {showCreate && (
        <Card title="Create retainer">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Eligibility is copied from the tier config snapshot. Pick how you want to handle
            payment:
          </p>
          <div style={{ display: 'grid', gap: 12, maxWidth: 540 }}>
            <fieldset
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                padding: 12,
                display: 'grid',
                gap: 8,
              }}
            >
              <legend
                style={{
                  padding: '0 6px',
                  fontSize: 11,
                  color: tokens.color.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                }}
              >
                Payment
              </legend>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                <input
                  type="radio"
                  checked={billClient}
                  onChange={() => setBillClient(true)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong>Bill the client</strong>
                  <br />
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    Creates a sent AR invoice for the retainer purchase. Retainer is held in
                    <em> pending_payment </em>and won&apos;t consume hours. Activates automatically
                    when the invoice is paid.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                <input
                  type="radio"
                  checked={!billClient}
                  onChange={() => setBillClient(false)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong>Already paid (record only)</strong>
                  <br />
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    Use when payment was collected out-of-band (cash, check, separate invoice) or
                    you&apos;re comping hours. Retainer is active immediately.
                  </span>
                </span>
              </label>
            </fieldset>
            <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Engagement
              <select
                value={createEngagementId}
                onChange={(e) => setCreateEngagementId(e.target.value)}
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              >
                <option value="">Select…</option>
                {engagements
                  .filter((e) => !e.hasRetainer)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.clientName ? `${e.clientName} — ` : ''}
                      {e.name}
                    </option>
                  ))}
              </select>
            </label>
            <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Tier
              <select
                value={createTierConfigId}
                onChange={(e) => setCreateTierConfigId(e.target.value)}
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              >
                <option value="">Select…</option>
                {tierConfigs.map((tc) => (
                  <option key={tc.id} value={tc.id}>
                    {tc.returnType} {tc.tier} — {tc.name} ({tc.hours}h)
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Hours (override — blank = use tier default)
              <input
                type="number"
                step={0.25}
                min={0}
                value={createHours}
                onChange={(e) =>
                  setCreateHours(e.target.value === '' ? '' : Number(e.target.value))
                }
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              />
            </label>
            <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Price (cents — override; blank = use tier base fee)
              <input
                type="number"
                min={0}
                value={createPriceCents}
                onChange={(e) =>
                  setCreatePriceCents(e.target.value === '' ? '' : Number(e.target.value))
                }
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              />
            </label>
            <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
              Notes (optional)
              <textarea
                rows={2}
                value={createNotes}
                onChange={(e) => setCreateNotes(e.target.value)}
                style={{
                  padding: 8,
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                type="button"
                onClick={() => void performCreate()}
                disabled={!createEngagementId || !createTierConfigId}
              >
                Create
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {voidId && (
        <Card title="Void retainer">
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
            Voiding clears the retainer and lets a new offer be issued against this engagement.
            Allowed only when no hours have been consumed (D24).
          </p>
          <label style={{ fontSize: 13, display: 'grid', gap: 4 }}>
            Reason
            <textarea
              rows={3}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              style={{
                padding: 8,
                fontSize: 13,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button type="button" onClick={performVoid} disabled={voidReason.length === 0}>
              Confirm void
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setVoidId(null);
                setVoidReason('');
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}
