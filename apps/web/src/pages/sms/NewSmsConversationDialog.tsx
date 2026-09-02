// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Start an outbound-initiated text (addendum Phase 9). The line picker
// only appears here (replies always use the thread's line — D2a). With a
// client prefilled, the "To" picker lists that client's people who have a
// number; otherwise staff type an E.164 number.

import { useEffect, useMemo, useState } from 'react';

import { Button, Combobox, Modal, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';
import { usePermission } from '../../auth-context';
import { formatPhone } from './ConversationRow';
import { SmsComposer } from './SmsComposer';
import type { SmsTemplate } from './types';

interface LineRow {
  id: string;
  phoneNumberE164: string;
  label: string | null;
  isDefault: boolean;
}
interface PersonRow {
  key: string;
  contact: { id: string; fullName: string; phone: string | null; mobile: string | null } | null;
  personId?: string;
}
interface ClientPick {
  id: string;
  name: string;
}
interface EngagementRow {
  id: string;
  name: string;
}

export interface NewSmsPrefill {
  to?: string;
  personId?: string | null;
  personName?: string | null;
  clientId?: string | null;
  clientName?: string | null;
  engagementId?: string | null;
}

export function NewSmsConversationDialog({
  prefill,
  onClose,
  onCreated,
}: {
  prefill?: NewSmsPrefill;
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}): JSX.Element {
  const canWrite = usePermission('messaging:write');
  const canSettings = usePermission('firm:settings:write');
  const [lines, setLines] = useState<LineRow[]>([]);
  const [lineId, setLineId] = useState('');
  const [clients, setClients] = useState<ClientPick[]>([]);
  const [clientId, setClientId] = useState(prefill?.clientId ?? '');
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [contactId, setContactId] = useState('');
  const [to, setTo] = useState(prefill?.to ?? '');
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [templates, setTemplates] = useState<SmsTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [block, setBlock] = useState<'consent_required' | 'opted_out' | 'a2p_unregistered' | null>(
    null,
  );
  const [blockedPersonId, setBlockedPersonId] = useState<string | null>(prefill?.personId ?? null);

  useEffect(() => {
    void api<{ items: LineRow[] }>('/api/staff/sms/lines')
      .then((r) => {
        setLines(r.items ?? []);
        setLineId(r.items?.find((l) => l.isDefault)?.id ?? r.items?.[0]?.id ?? '');
      })
      .catch(() => undefined);
    void api<{ items: SmsTemplate[] }>('/api/staff/sms/templates')
      .then((r) => setTemplates(r.items ?? []))
      .catch(() => undefined);
    if (!prefill?.clientId) {
      void api<{ items: ClientPick[] }>('/api/staff/clients/picker')
        .then((r) => setClients(r.items ?? []))
        .catch(() => undefined);
    }
  }, [prefill?.clientId]);

  useEffect(() => {
    setPeople([]);
    setEngagements([]);
    if (!clientId) return;
    void api<{ people: PersonRow[] }>(`/api/staff/clients/${clientId}/people`)
      .then((r) =>
        setPeople(
          (r.people ?? []).filter((p) => p.contact && (p.contact.mobile || p.contact.phone)),
        ),
      )
      .catch(() => undefined);
    void api<{ items: EngagementRow[] }>(`/api/staff/engagements?clientId=${clientId}`)
      .then((r) => setEngagements(r.items ?? []))
      .catch(() => undefined);
  }, [clientId]);

  const selected = people.find((p) => p.contact?.id === contactId)?.contact ?? null;
  useEffect(() => {
    if (selected) setTo(selected.mobile ?? selected.phone ?? '');
  }, [selected]);

  const validTo = useMemo(() => /^\+?[\d\s().-]{7,20}$/.test(to.trim()), [to]);
  const composerDetail = useMemo(
    () => ({
      // Minimal detail shape for the composer's template vars + banners.
      id: '',
      templateVars: {
        client_first:
          (selected?.fullName ?? prefill?.personName ?? prefill?.clientName ?? '').split(
            /[\s,]+/,
          )[0] || null,
        engagement_name: null,
        staff_first: null,
        firm: null,
      },
      contact: selected
        ? { personId: blockedPersonId ?? '', name: selected.fullName, smsOptOut: false }
        : prefill?.personId
          ? { personId: prefill.personId, name: prefill.personName ?? '', smsOptOut: false }
          : null,
      optOut: { active: false, at: null, source: null },
      piiWarningsEnabled: false,
      engagementOptions: engagements.map((e) => ({ ...e, status: 'ACTIVE' })),
    }),
    [selected, prefill, engagements, blockedPersonId],
  );

  async function submit(draft: { body: string; engagementId: string | null }): Promise<void> {
    setError(null);
    try {
      const r = await api<{ conversationId: string }>('/api/staff/sms/conversations', {
        method: 'POST',
        body: JSON.stringify({
          to: to.trim(),
          body: draft.body,
          lineId: lineId || undefined,
          clientId: clientId || null,
          personId: prefill?.personId ?? null,
          engagementId: draft.engagementId,
        }),
      });
      onCreated(r.conversationId);
    } catch (err) {
      const e = err as ApiError & { body?: { reason?: string; personId?: string | null } };
      if (e.status === 409 && e.body?.reason) {
        const reason = e.body.reason;
        setBlock(
          reason === 'no_consent'
            ? 'consent_required'
            : reason === 'opted_out' || reason === 'a2p_unregistered'
              ? reason
              : null,
        );
        if (e.body.personId) setBlockedPersonId(e.body.personId);
        if (reason === 'no_line') setError('No texting line is configured.');
        throw err;
      }
      setError(e.message || 'send_failed');
      throw err;
    }
  }

  async function recordConsent(): Promise<void> {
    const pid = blockedPersonId;
    if (!pid) return;
    await api(`/api/staff/people/${pid}/sms-consent`, {
      method: 'POST',
      body: JSON.stringify({ source: 'verbal' }),
    });
    setBlock(null);
  }

  return (
    <Modal title="New text" onClose={onClose} maxWidth={560}>
      <div style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        {lines.length > 1 && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>From line</span>
            <Combobox
              ariaLabel="From line"
              value={lineId}
              onChange={setLineId}
              options={lines.map((l) => ({
                value: l.id,
                label: `${l.label ?? formatPhone(l.phoneNumberE164)}${l.isDefault ? ' (default)' : ''}`,
                description: l.label ? formatPhone(l.phoneNumberE164) : undefined,
              }))}
            />
          </div>
        )}
        {lines.length === 0 && (
          <p style={{ margin: 0, fontSize: 12, color: tokens.color.warning }} role="status">
            No texting lines yet —{' '}
            {canSettings ? (
              <a href="/admin/sms-inbox" style={{ color: tokens.color.accent }}>
                set up the SMS inbox
              </a>
            ) : (
              'ask an administrator'
            )}
            .
          </p>
        )}
        {!prefill?.clientId && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Client (optional)</span>
            <Combobox
              ariaLabel="Client"
              value={clientId}
              onChange={setClientId}
              placeholder="Search clients…"
              options={[
                { value: '', label: '— none —' },
                ...clients.map((c) => ({ value: c.id, label: c.name })),
              ]}
              clearable
            />
          </div>
        )}
        {prefill?.clientName && (
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Client: {prefill.clientName}
          </span>
        )}
        {clientId && people.length > 0 && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>To (contact)</span>
            <Combobox
              ariaLabel="Contact to text"
              value={contactId}
              onChange={setContactId}
              placeholder="— type a number below, or pick —"
              options={[
                { value: '', label: '— enter a number —' },
                ...people.map((p) => ({
                  value: p.contact!.id,
                  label: p.contact!.fullName,
                  description: p.contact!.mobile ?? p.contact!.phone ?? undefined,
                })),
              ]}
            />
          </div>
        )}
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>To (mobile number)</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="+1 (312) 555-0148"
            disabled={Boolean(selected)}
            style={{
              padding: '8px 10px',
              background: tokens.color.surface,
              color: tokens.color.text,
              border: `1px solid ${validTo || !to ? tokens.color.border : tokens.color.danger}`,
              borderRadius: tokens.radius.md,
              fontSize: 13,
            }}
          />
        </label>
        <SmsComposer
          mode="new"
          // reason: the composer only reads templateVars/contact/optOut/engagementOptions/piiWarningsEnabled/id from the detail
          detail={composerDetail as never}
          canWrite={canWrite && validTo && lines.length > 0}
          canSettings={canSettings}
          templates={templates}
          engagementId={prefill?.engagementId ?? null}
          engagementOptions={engagements}
          block={block}
          onSubmit={submit}
          onRecordConsent={blockedPersonId ? recordConsent : undefined}
        />
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
