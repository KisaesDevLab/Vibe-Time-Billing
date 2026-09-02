// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// One row of the SMS inbox list. Unread styling mirrors the team-messages
// list (tinted bubble + accent rule + bold), with a selection checkbox for
// bulk actions kept OUTSIDE the row button (no nested interactives).

import { Pill, tokens } from '@vibe/ui';

import type { SmsConversation } from './types';

export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(t).toLocaleDateString();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

export function ConversationRow({
  row,
  active,
  checked,
  onOpen,
  onToggle,
}: {
  row: SmsConversation;
  active: boolean;
  checked: boolean;
  onOpen: () => void;
  onToggle: () => void;
}): JSX.Element {
  const hasUnread = row.unreadCount > 0;
  const title = row.contact?.name ?? row.client?.name ?? formatPhone(row.externalNumberE164);
  const secondary = [
    row.client?.name && row.contact ? row.client.name : null,
    row.engagement ? `${row.engagement.name}${row.engagement.suggested ? '?' : ''}` : null,
    row.lineLabel,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Select conversation with ${title}`}
        style={{ alignSelf: 'center', margin: '0 0 0 4px' }}
      />
      <button
        type="button"
        onClick={onOpen}
        style={{
          flex: 1,
          minWidth: 0,
          textAlign: 'left',
          padding: '10px 12px',
          borderRadius: tokens.radius.sm,
          background: active || hasUnread ? tokens.color.accentMuted : 'transparent',
          border: 'none',
          borderLeft: `3px solid ${active || hasUnread ? tokens.color.accent : 'transparent'}`,
          color: active || hasUnread ? tokens.color.accent : tokens.color.text,
          cursor: 'pointer',
          fontSize: 13,
          display: 'grid',
          gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span
            style={{
              fontWeight: hasUnread ? 700 : 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
            }}
          >
            {title}
          </span>
          {row.needsTriage && <Pill tone="warning">Needs triage</Pill>}
          {!row.client && !row.needsTriage && <Pill tone="neutral">Unassigned</Pill>}
          {row.pendingReschedule && <Pill tone="warning">Reschedule</Pill>}
          {row.status === 'closed' && <Pill tone="neutral">Closed</Pill>}
          {row.status === 'spam' && <Pill tone="danger">Spam</Pill>}
          {row.contact?.smsOptOut && <Pill tone="danger">Opted out</Pill>}
          {hasUnread && (
            <span
              style={{
                background: tokens.color.accent,
                color: '#fff',
                borderRadius: tokens.radius.pill,
                fontSize: 11,
                padding: '1px 7px',
                minWidth: 18,
                textAlign: 'center',
              }}
            >
              {row.unreadCount}
            </span>
          )}
        </div>
        {secondary && (
          <div
            style={{
              fontSize: 11,
              color: tokens.color.textMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {secondary}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              color: hasUnread ? tokens.color.text : tokens.color.textMuted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.lastDirection === 'inbound' ? '↩ ' : row.lastDirection === 'outbound' ? '→ ' : ''}
            {row.lastMessagePreview || '(no text)'}
          </span>
          <span style={{ fontSize: 11, color: tokens.color.textMuted, whiteSpace: 'nowrap' }}>
            {relativeTime(row.lastMessageAt)}
          </span>
          {row.assignedUser && (
            <span
              title={`Assigned to ${row.assignedUser.name}`}
              style={{
                fontSize: 10,
                fontWeight: 600,
                width: 20,
                height: 20,
                borderRadius: '50%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: tokens.color.border,
                color: tokens.color.text,
              }}
            >
              {initials(row.assignedUser.name)}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}
