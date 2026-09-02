// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Header strip for an SMS thread: contact / client / engagement chips
// (suggested vs confirmed), assignee picker, and the overflow menu of
// conversation actions. Gated actions stay visible but disabled with a
// reason (house convention).

import { Combobox, Menu, Pill, tokens } from '@vibe/ui';

import { formatPhone } from './ConversationRow';
import type { SmsConversationDetail } from './types';

export type ThreadAction =
  | 'mark_unread'
  | 'assign_me'
  | 'link'
  | 'unlink'
  | 'rematch'
  | 'time_entry'
  | 'reopen'
  | 'close'
  | 'spam'
  | 'set_engagement';

export function SmsThreadHeader({
  detail,
  users,
  canWrite,
  canAssign,
  onAction,
  onAssign,
}: {
  detail: SmsConversationDetail;
  users: Array<{ id: string; fullName: string }>;
  canWrite: boolean;
  canAssign: boolean;
  onAction: (a: ThreadAction) => void;
  onAssign: (userId: string | null) => void;
}): JSX.Element {
  const closed = detail.status !== 'open';
  const chip = (
    label: string,
    href?: string,
    tone: 'neutral' | 'accent' | 'warning' = 'neutral',
  ): JSX.Element =>
    href ? (
      <a href={href} style={{ textDecoration: 'none' }}>
        <Pill tone={tone}>{label}</Pill>
      </a>
    ) : (
      <Pill tone={tone}>{label}</Pill>
    );
  return (
    <div
      style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}
    >
      <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
        {formatPhone(detail.externalNumberE164)}
      </span>
      {detail.contact ? chip(detail.contact.name, `/people/${detail.contact.personId}`) : null}
      {detail.client
        ? chip(
            detail.client.name,
            detail.client.restricted ? undefined : `/clients/${detail.client.id}`,
            'accent',
          )
        : chip('No client', undefined)}
      {detail.engagement ? (
        <span
          title={
            detail.engagement.suggested
              ? 'Suggested — auto-confirms on your first reply'
              : 'Engagement'
          }
        >
          {chip(
            `${detail.engagement.suggested ? 'Suggested: ' : ''}${detail.engagement.name}`,
            `/engagements/${detail.engagement.id}`,
            detail.engagement.suggested ? 'warning' : 'accent',
          )}
        </span>
      ) : detail.client ? (
        <button
          type="button"
          onClick={() => onAction('set_engagement')}
          disabled={!canWrite}
          style={{
            background: 'none',
            border: `1px dashed ${tokens.color.border}`,
            borderRadius: tokens.radius.pill,
            color: tokens.color.textMuted,
            cursor: 'pointer',
            fontSize: 11,
            padding: '1px 8px',
          }}
        >
          Set engagement
        </button>
      ) : null}
      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>via {detail.lineLabel}</span>
      {closed && (
        <Pill tone={detail.status === 'spam' ? 'danger' : 'neutral'}>{detail.status}</Pill>
      )}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        {canAssign ? (
          <Combobox
            ariaLabel="Assignee"
            size="sm"
            width={170}
            value={detail.assignedUser?.id ?? ''}
            onChange={(v) => onAssign(v || null)}
            placeholder="Unassigned"
            options={[
              { value: '', label: '— unassigned —' },
              ...users.map((u) => ({ value: u.id, label: u.fullName })),
            ]}
          />
        ) : (
          <Pill tone="neutral">
            {detail.assignedUser ? detail.assignedUser.name : 'Unassigned'}
          </Pill>
        )}
        <Menu
          ariaLabel="Conversation actions"
          items={[
            { key: 'unread', label: 'Mark unread', onSelect: () => onAction('mark_unread') },
            {
              key: 'assign_me',
              label: 'Assign to me',
              onSelect: () => onAction('assign_me'),
              disabled: !canAssign,
              disabledReason: 'Needs sms:assign',
            },
            {
              key: 'link',
              label: detail.client ? 'Change client…' : 'Link to client…',
              onSelect: () => onAction('link'),
              disabled: !canAssign,
              disabledReason: 'Needs sms:assign',
            },
            {
              key: 'unlink',
              label: 'Unlink client',
              onSelect: () => onAction('unlink'),
              hidden: !detail.client,
              disabled: !canAssign,
              disabledReason: 'Needs sms:assign',
            },
            {
              key: 'rematch',
              label: 'Re-run matching',
              onSelect: () => onAction('rematch'),
              disabled: !canAssign || detail.linkSource === 'manual',
              disabledReason:
                detail.linkSource === 'manual'
                  ? 'Manually linked — unlink first'
                  : 'Needs sms:write',
            },
            {
              key: 'time',
              label: 'Create time entry…',
              onSelect: () => onAction('time_entry'),
              disabled: !detail.engagement,
              disabledReason: 'Link an engagement first',
            },
            {
              key: 'reopen',
              label: 'Reopen',
              onSelect: () => onAction('reopen'),
              hidden: !closed,
              disabled: !canWrite,
              disabledReason: 'Needs sms:write',
            },
            {
              key: 'close',
              label: 'Close',
              onSelect: () => onAction('close'),
              hidden: closed,
              disabled: !canWrite,
              disabledReason: 'Needs sms:write',
            },
            {
              key: 'spam',
              label: 'Mark as spam',
              onSelect: () => onAction('spam'),
              hidden: detail.status === 'spam',
              disabled: !canWrite,
              disabledReason: 'Needs sms:write',
              danger: true,
            },
          ]}
        />
      </span>
    </div>
  );
}
