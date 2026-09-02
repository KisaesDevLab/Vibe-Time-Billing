// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Shown above a thread whose number matches several contacts (§3 step 3):
// one-click link per candidate, or open the full link dialog.

import { Button, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import type { SmsConversationDetail } from './types';

export function TriagePanel({
  detail,
  canAssign,
  onLinked,
  onPickOther,
}: {
  detail: SmsConversationDetail;
  canAssign: boolean;
  onLinked: (updated: SmsConversationDetail) => void;
  onPickOther: () => void;
}): JSX.Element {
  async function link(c: SmsConversationDetail['candidates'][number]): Promise<void> {
    const updated = await api<SmsConversationDetail>(
      `/api/staff/sms/conversations/${detail.id}/link`,
      {
        method: 'POST',
        body: JSON.stringify({ clientId: c.clientId, clientContactId: c.clientContactId }),
      },
    );
    onLinked(updated);
  }
  return (
    <div
      role="status"
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderLeft: `4px solid ${tokens.color.warning}`,
        borderRadius: tokens.radius.md,
        padding: '8px 10px',
        fontSize: 12,
        display: 'grid',
        gap: 6,
        marginBottom: 8,
      }}
    >
      <strong>This number matches more than one contact — who is texting?</strong>
      {detail.candidates.map((c) => (
        <div
          key={`${c.personId}:${c.clientId}`}
          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <span style={{ flex: 1 }}>
            {c.name} · {c.clientName}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={!canAssign}
            title={canAssign ? undefined : 'Needs sms:assign'}
            onClick={() => void link(c)}
          >
            Link
          </Button>
        </div>
      ))}
      <button
        type="button"
        onClick={onPickOther}
        disabled={!canAssign}
        style={{
          background: 'none',
          border: 'none',
          color: tokens.color.accent,
          cursor: 'pointer',
          fontSize: 12,
          textAlign: 'left',
          padding: 0,
        }}
      >
        None of these — pick a client…
      </button>
    </div>
  );
}
