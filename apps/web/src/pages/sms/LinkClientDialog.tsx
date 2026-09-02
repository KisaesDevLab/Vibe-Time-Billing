// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Link an SMS conversation to a client (and optionally a specific contact
// + engagement), with "also add this number to the contact" (§3 step 4).

import { useEffect, useState } from 'react';

import { Button, Combobox, Modal, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { formatPhone } from './ConversationRow';
import type { SmsConversationDetail } from './types';

interface ClientPick {
  id: string;
  name: string;
  externalId?: string | null;
}
interface PersonRow {
  key: string;
  contact: { id: string; fullName: string; phone: string | null; mobile: string | null } | null;
}
interface EngagementRow {
  id: string;
  name: string;
}

export function LinkClientDialog({
  detail,
  initialClientId,
  onClose,
  onLinked,
}: {
  detail: SmsConversationDetail;
  initialClientId?: string | null;
  onClose: () => void;
  onLinked: (updated: SmsConversationDetail) => void;
}): JSX.Element {
  const [clients, setClients] = useState<ClientPick[]>([]);
  const [clientId, setClientId] = useState(initialClientId ?? '');
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [contactId, setContactId] = useState('');
  const [engagements, setEngagements] = useState<EngagementRow[]>([]);
  const [engagementId, setEngagementId] = useState('');
  const [addNumber, setAddNumber] = useState<'' | 'mobile' | 'phone'>('mobile');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ items: ClientPick[] }>('/api/staff/clients/picker')
      .then((r) => setClients(r.items ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setContactId('');
    setEngagementId('');
    setPeople([]);
    setEngagements([]);
    if (!clientId) return;
    void api<{ people: PersonRow[] }>(`/api/staff/clients/${clientId}/people`)
      .then((r) => setPeople((r.people ?? []).filter((p) => p.contact)))
      .catch(() => undefined);
    void api<{ items: EngagementRow[] }>(`/api/staff/engagements?clientId=${clientId}`)
      .then((r) => setEngagements(r.items ?? []))
      .catch(() => undefined);
  }, [clientId]);

  const number = detail.externalNumberE164;
  const selectedContact = people.find((p) => p.contact?.id === contactId)?.contact ?? null;
  const contactHasNumber = Boolean(
    selectedContact &&
    [selectedContact.mobile, selectedContact.phone].some((v) =>
      (v ?? '').replace(/\D/g, '').endsWith(number.replace(/\D/g, '').slice(-10)),
    ),
  );

  async function submit(): Promise<void> {
    if (!clientId) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<SmsConversationDetail>(
        `/api/staff/sms/conversations/${detail.id}/link`,
        {
          method: 'POST',
          body: JSON.stringify({
            clientId,
            clientContactId: contactId || null,
            engagementId: engagementId || null,
            addNumberToContact: contactId && addNumber && !contactHasNumber ? addNumber : null,
          }),
        },
      );
      onLinked(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'link_failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Link ${formatPhone(number)} to a client`}
      onClose={busy ? undefined : onClose}
      maxWidth={520}
    >
      <div style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Client</span>
          <Combobox
            ariaLabel="Client"
            value={clientId}
            onChange={setClientId}
            placeholder="Search clients…"
            options={clients.map((c) => ({
              value: c.id,
              label: c.name,
              description: c.externalId ?? undefined,
            }))}
          />
        </div>
        {clientId && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Contact (optional)</span>
            <Combobox
              ariaLabel="Contact"
              value={contactId}
              onChange={setContactId}
              placeholder="— pick a person —"
              options={[
                { value: '', label: '— none —' },
                ...people.map((p) => ({
                  value: p.contact!.id,
                  label: p.contact!.fullName,
                  description: p.contact!.mobile ?? p.contact!.phone ?? undefined,
                })),
              ]}
            />
            {contactId && !contactHasNumber && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={addNumber !== ''}
                  onChange={(e) => setAddNumber(e.target.checked ? 'mobile' : '')}
                />
                Also save {formatPhone(number)} as this person&apos;s
                <select
                  value={addNumber || 'mobile'}
                  disabled={addNumber === ''}
                  onChange={(e) => setAddNumber(e.target.value as 'mobile' | 'phone')}
                  aria-label="Which phone field"
                  style={{ fontSize: 12 }}
                >
                  <option value="mobile">mobile</option>
                  <option value="phone">phone</option>
                </select>
              </label>
            )}
          </div>
        )}
        {clientId && engagements.length > 0 && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
              Engagement (optional)
            </span>
            <Combobox
              ariaLabel="Engagement"
              value={engagementId}
              onChange={setEngagementId}
              placeholder="— none —"
              options={[
                { value: '', label: '— none —' },
                ...engagements.map((e) => ({ value: e.id, label: e.name })),
              ]}
            />
          </div>
        )}
        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }} role="alert">
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!clientId || busy}>
            {busy ? 'Linking…' : 'Link'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
