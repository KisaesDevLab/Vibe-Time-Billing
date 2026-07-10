// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Per-engagement progress-status change history: who moved it from one
// status to another, and when. Reads the already-logged audit trail via
// GET /api/staff/engagements/:id/status-history.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { usePermission } from '../auth-context';

interface StatusHistoryRow {
  occurredAt: string;
  actorName: string | null;
  fromKey: string | null;
  fromLabel: string | null;
  toKey: string | null;
  toLabel: string | null;
}

export function EngagementStatusHistoryCard({
  engagementId,
}: {
  engagementId: string;
}): JSX.Element {
  const [items, setItems] = useState<StatusHistoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const canReprocess = usePermission('notification:approve');

  // 0166 — re-initiate the client notification for the engagement's CURRENT
  // status. Always queues for approval; recipients are the currently
  // opted-in contacts per the status config.
  async function reprocess(): Promise<void> {
    setResending(true);
    setResendMsg(null);
    try {
      await api(`/api/staff/engagements/${engagementId}/restage-status-notification`, {
        method: 'POST',
        body: '{}',
      });
      setResendMsg({ tone: 'ok', text: 'Queued for approval — review it in Approvals.' });
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setResendMsg({
        tone: 'err',
        text:
          code === 'status_not_configured_for_notify'
            ? "This status isn't set to notify clients."
            : code === 'no_workflow_state'
              ? 'This engagement has no status set yet.'
              : 'Could not queue the notification.',
      });
    } finally {
      setResending(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: StatusHistoryRow[] }>(
          `/api/staff/engagements/${engagementId}/status-history`,
        );
        setItems(r.items ?? []);
      } catch {
        setItems([]);
      } finally {
        setLoaded(true);
      }
    })();
  }, [engagementId]);

  return (
    <Card
      title="Status history"
      action={
        canReprocess ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {resendMsg && (
              <span
                style={{
                  fontSize: 12,
                  color: resendMsg.tone === 'ok' ? tokens.color.success : tokens.color.danger,
                }}
              >
                {resendMsg.tone === 'ok' ? (
                  <>
                    {resendMsg.text.replace(' — review it in Approvals.', ' — ')}
                    <a href="/approvals">Approvals</a>
                  </>
                ) : (
                  resendMsg.text
                )}
              </span>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={resending}
              title="Re-send this engagement's current-status notification to the approval queue"
              onClick={() => void reprocess()}
            >
              {resending ? 'Queuing…' : 'Re-send status notification'}
            </Button>
          </span>
        ) : undefined
      }
    >
      {!loaded ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
          No status changes recorded yet.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {items.map((r, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ color: tokens.color.textMuted, minWidth: 130 }}>
                {new Date(r.occurredAt).toLocaleString()}
              </span>
              <strong>{r.actorName ?? 'System'}</strong>
              <span style={{ color: tokens.color.textMuted }}>moved</span>
              <Pill tone="neutral">{r.fromLabel ?? r.fromKey ?? '—'}</Pill>
              <span style={{ color: tokens.color.textMuted }}>→</span>
              <Pill tone="success">{r.toLabel ?? r.toKey ?? '—'}</Pill>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
