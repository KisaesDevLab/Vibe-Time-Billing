// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// SMS reply / new-message composer (addendum Phase 8). Engagement picker,
// quick-reply templates rendered client-side at insert time (what you see
// is what sends), GSM-7/UCS-2 segment counter, unresolved-variable and
// PII warnings, Ctrl/Cmd+Enter to send, and the policy-state banners
// (opted out / consent required / A2P / closed) driven by the detail or a
// 409 from the send endpoint.

import { useEffect, useMemo, useState } from 'react';

import { Button, Combobox, Menu, Pill, tokens } from '@vibe/ui';
import { countSmsSegments, renderSmsTemplate } from '@vibe/core/sms';

import { api, type ApiError } from '../../api-client';
import { composerTextareaStyle } from '../messaging/styles';
import type { SmsConversationDetail, SmsReplyBlockReason, SmsTemplate } from './types';

export type ComposerBlock = SmsReplyBlockReason | 'a2p_unregistered' | null;

export interface SmsComposerProps {
  mode: 'reply' | 'new';
  detail: SmsConversationDetail | null;
  canWrite: boolean;
  canSettings: boolean;
  templates: SmsTemplate[];
  /** initial engagement (reply: the thread's; new: caller-provided) */
  engagementId?: string | null;
  engagementOptions?: Array<{ id: string; name: string }>;
  /** reply mode: POST to the conversation; new mode: hand the draft up */
  onSubmit: (draft: { body: string; engagementId: string | null }) => Promise<void>;
  onRecordConsent?: () => Promise<void>;
  onReopen?: () => Promise<void>;
  /** externally-known block (e.g. detail.replyBlockReason) */
  block?: ComposerBlock;
  busy?: boolean;
  placeholder?: string;
}

const PII_HINT: Record<string, string> = {
  ssn: 'an SSN',
  ein: 'an EIN',
  card: 'a card number',
  routing: 'a routing number',
  account: 'an account number',
  dob: 'a date of birth',
};

export function ComposerStateBanner({
  block,
  detail,
  canWrite,
  canSettings,
  onRecordConsent,
  onReopen,
  busy,
}: {
  block: ComposerBlock;
  detail: SmsConversationDetail | null;
  canWrite: boolean;
  canSettings: boolean;
  onRecordConsent?: () => Promise<void>;
  onReopen?: () => Promise<void>;
  busy?: boolean;
}): JSX.Element | null {
  if (!block) return null;
  const who = detail?.contact?.name ?? 'this contact';
  const box = (tone: 'danger' | 'warning' | 'neutral', body: React.ReactNode): JSX.Element => (
    <div
      role="status"
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '8px 10px',
        borderRadius: tokens.radius.md,
        border: `1px solid ${tokens.color.border}`,
        borderLeft: `4px solid ${tone === 'danger' ? tokens.color.danger : tone === 'warning' ? tokens.color.warning : tokens.color.border}`,
        fontSize: 12,
        marginBottom: 8,
      }}
    >
      {body}
    </div>
  );
  switch (block) {
    case 'opted_out':
      return box(
        'danger',
        <>
          <Pill tone="danger">Opted out</Pill>
          <span>
            {who} texted STOP
            {detail?.optOut.at ? ` on ${new Date(detail.optOut.at).toLocaleDateString()}` : ''}.
            They must text START to resume — this can&apos;t be overridden.
          </span>
        </>,
      );
    case 'consent_required':
      return box(
        'warning',
        <>
          <Pill tone="warning">No consent on file</Pill>
          <span style={{ flex: 1 }}>
            {who} hasn&apos;t agreed to receive texts. Record verbal consent, or wait for them to
            text first.
          </span>
          {onRecordConsent && detail?.contact ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite || busy}
              title={canWrite ? undefined : 'Needs sms:write'}
              onClick={() => void onRecordConsent()}
            >
              Record verbal consent
            </Button>
          ) : (
            <span style={{ color: tokens.color.textMuted }}>Link a contact to record consent.</span>
          )}
        </>,
      );
    case 'a2p_unregistered':
      return box(
        'warning',
        <>
          <Pill tone="warning">10DLC not registered</Pill>
          <span style={{ flex: 1 }}>
            US long-code sends are blocked until A2P registration completes in Twilio.
          </span>
          {canSettings ? (
            <a href="/admin/sms-inbox" style={{ color: tokens.color.accent }}>
              SMS inbox settings →
            </a>
          ) : (
            <span style={{ color: tokens.color.textMuted }}>Ask an administrator.</span>
          )}
        </>,
      );
    case 'closed':
    case 'spam':
      return box(
        'neutral',
        <>
          <Pill tone="neutral">{block === 'spam' ? 'Marked spam' : 'Closed'}</Pill>
          <span style={{ flex: 1 }}>Reopen the conversation to reply.</span>
          {onReopen && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite || busy}
              onClick={() => void onReopen()}
            >
              Reopen
            </Button>
          )}
        </>,
      );
    default:
      return null;
  }
}

export function SegmentCounter({ text }: { text: string }): JSX.Element {
  const info = useMemo(() => countSmsSegments(text), [text]);
  const tone =
    info.segments > 5
      ? tokens.color.danger
      : info.segments > 1
        ? tokens.color.warning
        : tokens.color.textMuted;
  return (
    <span
      style={{ fontSize: 11, color: tone, whiteSpace: 'nowrap' }}
      title="Twilio bills per segment"
    >
      {info.units} / {info.perSegment} · {info.encoding} · {info.segments} segment
      {info.segments === 1 ? '' : 's'}
    </span>
  );
}

export function SmsComposer(props: SmsComposerProps): JSX.Element {
  const { mode, detail, canWrite, canSettings, templates, onSubmit, block: externalBlock } = props;
  const [draft, setDraft] = useState('');
  const [engagementId, setEngagementId] = useState<string>(props.engagementId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [block, setBlock] = useState<ComposerBlock>(externalBlock ?? null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [piiFlags, setPiiFlags] = useState<string[]>([]);

  useEffect(() => setBlock(externalBlock ?? null), [externalBlock]);
  useEffect(() => setEngagementId(props.engagementId ?? ''), [props.engagementId]);

  // Phase 11 — server-side pattern check (debounced) when the firm has it on.
  useEffect(() => {
    if (!detail?.piiWarningsEnabled || !detail.id || !draft.trim()) {
      setPiiFlags([]);
      return;
    }
    const t = setTimeout(() => {
      void api<{ flags: string[] }>(
        `/api/staff/sms/conversations/${detail.id}/messages/preview-flags`,
        {
          method: 'POST',
          body: JSON.stringify({ body: draft }),
        },
      )
        .then((r) => setPiiFlags(r.flags ?? []))
        .catch(() => setPiiFlags([]));
    }, 400);
    return () => clearTimeout(t);
  }, [draft, detail?.id, detail?.piiWarningsEnabled]);

  const options = props.engagementOptions ?? detail?.engagementOptions ?? [];
  const disabled = !canWrite || Boolean(block) || busy || props.busy;
  const disabledReason = !canWrite
    ? 'Needs sms:write'
    : block
      ? 'Sending is blocked for this conversation'
      : undefined;

  function insertTemplate(t: SmsTemplate): void {
    const vars = detail?.templateVars ?? {};
    const r = renderSmsTemplate(t.body, vars);
    setUnresolved(r.unresolved);
    setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, '')}\n${r.text}` : r.text));
  }

  async function submit(): Promise<void> {
    const body = draft.trim();
    if (!body || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ body, engagementId: engagementId || null });
      setDraft('');
      setUnresolved([]);
    } catch (err) {
      const e = err as ApiError & { body?: { error?: string; reason?: string } };
      const reason = e.body?.reason;
      if (e.status === 409 && reason) {
        setBlock(
          reason === 'no_consent'
            ? 'consent_required'
            : reason === 'opted_out' ||
                reason === 'a2p_unregistered' ||
                reason === 'closed' ||
                reason === 'spam'
              ? reason
              : null,
        );
        setError(reason === 'no_line' ? 'No texting line is configured.' : null);
      } else {
        setError(e.message || 'send_failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <ComposerStateBanner
        block={block}
        detail={detail}
        canWrite={canWrite}
        canSettings={canSettings}
        onRecordConsent={props.onRecordConsent}
        onReopen={props.onReopen}
        busy={busy}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {options.length > 0 || engagementId ? (
          <Combobox
            ariaLabel="Engagement for this text"
            size="sm"
            width={240}
            value={engagementId}
            onChange={setEngagementId}
            placeholder="— No engagement —"
            options={[
              { value: '', label: '— No engagement —' },
              ...options.map((o) => ({ value: o.id, label: o.name })),
            ]}
            disabled={disabled && !busy}
          />
        ) : mode === 'reply' && detail && !detail.client ? (
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Link a client to pick an engagement.
          </span>
        ) : null}
        {detail?.engagement?.suggested && engagementId === detail.engagement.id && (
          <span style={{ fontSize: 11, color: tokens.color.warning }}>
            Suggested — sending confirms it
          </span>
        )}
        {templates.length > 0 && (
          <Menu
            ariaLabel="Insert template"
            trigger={<span style={{ fontSize: 12 }}>Template ▾</span>}
            disabled={disabled}
            items={templates.map((t) => ({
              key: t.id,
              label: `${t.name}${t.scope === 'firm' ? '' : ' (mine)'}`,
              onSelect: () => insertTemplate(t),
            }))}
          />
        )}
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={
          props.placeholder ??
          (mode === 'reply'
            ? 'Reply by text… (Ctrl/Cmd+Enter to send)'
            : 'Type your text… (Ctrl/Cmd+Enter to send)')
        }
        rows={3}
        disabled={!canWrite || Boolean(block)}
        aria-label={mode === 'reply' ? 'Reply by text' : 'Text message'}
        style={composerTextareaStyle}
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <SegmentCounter text={draft} />
        {unresolved.length > 0 && (
          <span style={{ fontSize: 11, color: tokens.color.warning }}>
            Fill in {unresolved.map((u) => `{${u}}`).join(', ')} before sending
          </span>
        )}
        {piiFlags.length > 0 && (
          <span style={{ fontSize: 11, color: tokens.color.danger }} role="alert">
            Looks like this contains {piiFlags.map((f) => PII_HINT[f] ?? f).join(', ')} — texts are
            not encrypted in transit to the carrier.
          </span>
        )}
        {error && (
          <span style={{ fontSize: 11, color: tokens.color.danger }} role="alert">
            {error}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <Button
            size="sm"
            disabled={disabled || !draft.trim()}
            title={disabledReason}
            onClick={() => void submit()}
          >
            {busy ? 'Sending…' : mode === 'reply' ? 'Send' : 'Send text'}
          </Button>
        </span>
      </div>
    </div>
  );
}
