// SPDX-License-Identifier: Elastic-2.0
//
// CP12 — Appointments admin page. Read-only mirror of the firm's
// calendar; staff enter rows here (or a future webhook posts into
// the same API). Clients see the same rows on the portal /appointments
// page with their RSVP-style copy.

import { useEffect, useState } from 'react';

import {
  Button,
  Card,
  EmptyState,
  Input,
  Pill,
  SectionHeading,
  Stat,
  Table,
  tokens,
} from '@vibe/ui';

import { api } from '../../api-client';

interface AppointmentRow {
  id: string;
  clientId: string;
  engagementId: string | null;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  location: 'VIDEO' | 'PHONE' | 'IN_PERSON';
  locationDetail: string | null;
  leadAppUserId: string | null;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  cancelledReason: string | null;
  /** CAL-9 — set when the appointment is mirrored to the lead's calendar. */
  externalRef: string | null;
}

interface ClientOption {
  id: string;
  name: string;
}

const statusTone = (s: AppointmentRow['status']): 'success' | 'warning' | 'neutral' =>
  s === 'SCHEDULED' ? 'warning' : s === 'COMPLETED' ? 'success' : 'neutral';

const locationLabel: Record<AppointmentRow['location'], string> = {
  VIDEO: 'Video',
  PHONE: 'Phone',
  IN_PERSON: 'In person',
};

export function AppointmentsPage(): JSX.Element {
  const [items, setItems] = useState<AppointmentRow[]>([]);
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createClientId, setCreateClientId] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createStartsAt, setCreateStartsAt] = useState('');
  const [createEndsAt, setCreateEndsAt] = useState('');
  const [createLocation, setCreateLocation] = useState<'VIDEO' | 'PHONE' | 'IN_PERSON'>('VIDEO');
  const [createLocationDetail, setCreateLocationDetail] = useState('');
  const [createDescription, setCreateDescription] = useState('');

  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: AppointmentRow[] }>('/api/staff/appointments');
      setItems(r.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function openCreate(): Promise<void> {
    setError(null);
    setShowCreate(true);
    if (clients.length === 0) {
      try {
        const r = await api<{ items: ClientOption[] }>('/api/staff/clients');
        setClients(r.items ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load clients failed');
      }
    }
  }

  async function performCreate(): Promise<void> {
    if (!createClientId || !createTitle || !createStartsAt || !createEndsAt) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ id: string; calendarPushed?: boolean }>('/api/staff/appointments', {
        method: 'POST',
        body: JSON.stringify({
          clientId: createClientId,
          title: createTitle,
          startsAt: createStartsAt,
          endsAt: createEndsAt,
          location: createLocation,
          locationDetail: createLocationDetail || undefined,
          description: createDescription || undefined,
        }),
      });
      if (res.calendarPushed) setNotice('Added to the lead’s connected calendar.');
      setShowCreate(false);
      setCreateClientId('');
      setCreateTitle('');
      setCreateStartsAt('');
      setCreateEndsAt('');
      setCreateLocation('VIDEO');
      setCreateLocationDetail('');
      setCreateDescription('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    }
  }

  async function performCancel(): Promise<void> {
    if (!cancelId || !cancelReason) return;
    setError(null);
    try {
      await api(`/api/staff/appointments/${cancelId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason: cancelReason }),
      });
      setCancelId(null);
      setCancelReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'cancel failed');
    }
  }

  async function performComplete(id: string): Promise<void> {
    setError(null);
    try {
      await api(`/api/staff/appointments/${id}/complete`, { method: 'POST', body: '{}' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'complete failed');
    }
  }

  const clientName = (id: string): string =>
    clients.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  const now = Date.now();
  const upcoming = items.filter(
    (i) => i.status === 'SCHEDULED' && new Date(i.startsAt).getTime() >= now,
  );
  const past24h = items.filter(
    (i) =>
      i.status === 'SCHEDULED' &&
      new Date(i.startsAt).getTime() < now &&
      new Date(i.startsAt).getTime() >= now - 24 * 3600_000,
  );

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1100 }}>
      <SectionHeading
        title="Appointments"
        description="Calendar entries the client sees on their portal. Add a row when you schedule a call; mark complete or cancel after."
        action={
          <Button type="button" onClick={() => void openCreate()}>
            New appointment
          </Button>
        }
      />

      <Card title="At a glance">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: tokens.space.md,
          }}
        >
          <Stat
            label="Upcoming"
            value={upcoming.length}
            tone={upcoming.length > 0 ? 'accent' : 'neutral'}
          />
          <Stat
            label="In the next 24h"
            value={
              upcoming.filter((i) => new Date(i.startsAt).getTime() < now + 24 * 3600_000).length
            }
            tone="warning"
          />
          <Stat
            label="Awaiting completion"
            value={past24h.length}
            tone={past24h.length > 0 ? 'warning' : 'neutral'}
          />
        </div>
      </Card>

      <Card title="All appointments">
        {items.length === 0 ? (
          <EmptyState
            icon="📅"
            title="No appointments yet"
            body="Schedule a meeting with a client and they'll see it on their portal."
          />
        ) : (
          <Table<AppointmentRow>
            columns={[
              { key: 'client', header: 'Client', render: (r) => clientName(r.clientId) },
              { key: 'title', header: 'Title', render: (r) => r.title },
              {
                key: 'when',
                header: 'When',
                render: (r) => (
                  <span style={{ fontSize: 12 }}>
                    {new Date(r.startsAt).toLocaleString()}
                    <span style={{ color: tokens.color.textMuted }}>
                      {' '}
                      → {new Date(r.endsAt).toLocaleTimeString()}
                    </span>
                  </span>
                ),
              },
              { key: 'loc', header: 'Where', render: (r) => locationLabel[r.location] },
              {
                key: 'status',
                header: 'Status',
                render: (r) => (
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                    {r.externalRef && r.status === 'SCHEDULED' && (
                      <span title="Mirrored to the lead’s connected calendar">
                        <Pill tone="neutral">📅 On calendar</Pill>
                      </span>
                    )}
                  </div>
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (r) =>
                  r.status === 'SCHEDULED' ? (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void performComplete(r.id)}
                      >
                        Mark complete
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setCancelId(r.id)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
            rows={items}
            rowKey={(r) => r.id}
          />
        )}
      </Card>

      {showCreate && (
        <Card title="Schedule an appointment">
          <div style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
            <ClientSelect
              label="Client *"
              value={createClientId}
              onChange={setCreateClientId}
              options={clients}
            />
            <Input
              label="Title *"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="Tax-prep call · Annual review · Audit kickoff"
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input
                label="Starts *"
                type="datetime-local"
                value={createStartsAt}
                onChange={(e) => setCreateStartsAt(e.target.value)}
              />
              <Input
                label="Ends *"
                type="datetime-local"
                value={createEndsAt}
                onChange={(e) => setCreateEndsAt(e.target.value)}
              />
            </div>
            <LocationSelect value={createLocation} onChange={setCreateLocation} />
            <Input
              label="Location detail (Zoom URL / phone / room)"
              value={createLocationDetail}
              onChange={(e) => setCreateLocationDetail(e.target.value)}
            />
            <Input
              label="Description (visible to client)"
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="button" onClick={() => void performCreate()}>
                Schedule
              </Button>
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      {cancelId && (
        <Card title="Cancel appointment">
          <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
            The client will see the cancellation reason on their portal.
          </p>
          <div style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
            <Input
              label="Reason *"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Client requested reschedule · Lead unavailable"
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="button" variant="danger" onClick={() => void performCancel()}>
                Cancel appointment
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCancelId(null)}>
                Never mind
              </Button>
            </div>
          </div>
        </Card>
      )}

      {notice && <p style={{ color: tokens.color.accent, fontSize: 12 }}>{notice}</p>}
      {error && <p style={{ color: tokens.color.danger, fontSize: 12 }}>{error}</p>}
    </div>
  );
}

function ClientSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ id: string; name: string }>;
}): JSX.Element {
  const id = 'apt-client-select';
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: tokens.color.textMuted }}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function LocationSelect({
  value,
  onChange,
}: {
  value: 'VIDEO' | 'PHONE' | 'IN_PERSON';
  onChange: (v: 'VIDEO' | 'PHONE' | 'IN_PERSON') => void;
}): JSX.Element {
  const id = 'apt-loc-select';
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, color: tokens.color.textMuted }}>
        Location
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as typeof value)}
        style={{
          padding: '8px 10px',
          fontSize: 13,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          color: tokens.color.text,
        }}
      >
        <option value="VIDEO">Video</option>
        <option value="PHONE">Phone</option>
        <option value="IN_PERSON">In person</option>
      </select>
    </div>
  );
}
