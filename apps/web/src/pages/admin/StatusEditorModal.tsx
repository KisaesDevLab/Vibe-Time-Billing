// SPDX-License-Identifier: Elastic-2.0
//
// Create/edit popup for a single engagement progress status. One modal for
// both create (status=null) and edit. Holds every per-status field today and
// is the place future per-status features attach (add new sections here).
// Modeled on the app's existing dialog pattern (fixed overlay + panel + Esc).

import { useEffect, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

export interface StatusConfigRow {
  firmId: string;
  workflowState: string;
  label: string;
  color: string;
  sortOrder: number;
  kanbanVisible: boolean;
  triggersClientComm: boolean;
  notifyMode: 'IMMEDIATE' | 'STAGED';
  notifyChannels: string[];
  notifyRecipients: 'BILLING_CONTACT' | 'ALL_CONTACTS';
  isSystem: boolean;
  clientLabel: string | null;
  clientDescription: string | null;
  clientVisible: boolean;
  // 0167 — service lines this status applies to (empty ⇒ all).
  serviceLineIds: string[];
}

export interface ServiceLineLite {
  id: string;
  name: string;
}

interface Props {
  status: StatusConfigRow | null; // null = create
  serviceLines: ServiceLineLite[];
  onClose: () => void;
  onSaved: () => void;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
};
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 8,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 14,
};

export function StatusEditorModal({ status, serviceLines, onClose, onSaved }: Props): JSX.Element {
  const creating = status === null;
  const [label, setLabel] = useState(status?.label ?? '');
  const [color, setColor] = useState(status?.color ?? '#6b7280');
  const [sortOrder, setSortOrder] = useState(status?.sortOrder ?? 100);
  const [kanbanVisible, setKanbanVisible] = useState(status?.kanbanVisible ?? true);
  const [clientLabel, setClientLabel] = useState(status?.clientLabel ?? '');
  const [clientDescription, setClientDescription] = useState(status?.clientDescription ?? '');
  const [clientVisible, setClientVisible] = useState(status?.clientVisible ?? true);
  const [serviceLineIds, setServiceLineIds] = useState<string[]>(status?.serviceLineIds ?? []);
  const [notifyEnabled, setNotifyEnabled] = useState(status?.triggersClientComm ?? false);
  const [notifyMode, setNotifyMode] = useState<'IMMEDIATE' | 'STAGED'>(
    status?.notifyMode ?? 'STAGED',
  );
  const [notifyChannels, setNotifyChannels] = useState<string[]>(status?.notifyChannels ?? []);
  const [notifyRecipients, setNotifyRecipients] = useState<'BILLING_CONTACT' | 'ALL_CONTACTS'>(
    status?.notifyRecipients ?? 'BILLING_CONTACT',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, busy]);

  async function submit(): Promise<void> {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    const body = {
      label: label.trim(),
      color,
      sortOrder,
      kanbanVisible,
      clientLabel: clientLabel.trim() || null,
      clientDescription: clientDescription.trim() || null,
      clientVisible,
      serviceLineIds,
      triggersClientComm: notifyEnabled,
      notifyMode,
      notifyChannels,
      notifyRecipients,
    };
    try {
      if (creating) {
        await api('/api/staff/admin/engagement-statuses', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } else {
        await api(`/api/staff/admin/engagement-statuses/${status!.workflowState}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      }
      onSaved();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!status) return;
    if (!window.confirm(`Delete status "${status.label}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/staff/admin/engagement-statuses/${status.workflowState}`, {
        method: 'DELETE',
      });
      onSaved();
    } catch (err) {
      const m = (err as ApiError).message;
      setError(
        m === 'status_in_use'
          ? 'Cannot delete: this status is in use by one or more engagements. Reassign them first.'
          : m === 'cannot_delete_system_status'
            ? 'Built-in statuses cannot be deleted.'
            : m,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={creating ? 'Add status' : 'Edit status'}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        disabled={busy}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'transparent',
          border: 'none',
          cursor: busy ? 'wait' : 'pointer',
        }}
      />
      <div
        style={{
          background: tokens.color.surface,
          borderRadius: tokens.radius.md,
          padding: 20,
          width: 'min(560px, 92vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          position: 'relative',
          zIndex: 1,
        }}
      >
        <h3 style={{ margin: '0 0 16px', fontSize: 16 }}>
          {creating ? 'Add status' : `Edit “${status!.label}”`}
          {status?.isSystem && (
            <span style={{ fontSize: 12, color: tokens.color.textMuted, fontWeight: 400 }}>
              {'  '}· built-in
            </span>
          )}
        </h3>

        <div style={{ display: 'grid', gap: 14 }}>
          {/* Staff-facing */}
          <div>
            <span style={labelStyle}>Internal label (staff)</span>
            <input
              style={inputStyle}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Awaiting documents"
            />
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end' }}>
            <div>
              <span style={labelStyle}>Color</span>
              <input
                type="color"
                value={color}
                aria-label="Color"
                onChange={(e) => setColor(e.target.value)}
                style={{
                  width: 48,
                  height: 32,
                  padding: 0,
                  border: 'none',
                  background: 'transparent',
                }}
              />
            </div>
            <div style={{ width: 110 }}>
              <span style={labelStyle}>Board order</span>
              <input
                type="number"
                style={inputStyle}
                value={String(sortOrder)}
                onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              />
            </div>
            <label
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                fontSize: 13,
                paddingBottom: 8,
              }}
            >
              <input
                type="checkbox"
                checked={kanbanVisible}
                onChange={(e) => setKanbanVisible(e.target.checked)}
              />
              Show on board
            </label>
          </div>

          {/* 0167 — service-line scoping */}
          <div>
            <span style={labelStyle}>Service lines</span>
            {serviceLines.length === 0 ? (
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                No service lines defined yet — this status applies to all engagements.
              </span>
            ) : (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {serviceLines.map((sl) => (
                    <label
                      key={sl.id}
                      style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}
                    >
                      <input
                        type="checkbox"
                        checked={serviceLineIds.includes(sl.id)}
                        onChange={(e) =>
                          setServiceLineIds((prev) =>
                            e.target.checked ? [...prev, sl.id] : prev.filter((id) => id !== sl.id),
                          )
                        }
                      />
                      {sl.name}
                    </label>
                  ))}
                </div>
                <span
                  style={{
                    fontSize: 12,
                    color: tokens.color.textMuted,
                    display: 'block',
                    marginTop: 4,
                  }}
                >
                  {serviceLineIds.length === 0
                    ? 'None selected — this status is available for every engagement.'
                    : 'Only engagements in the selected service lines will offer this status.'}
                </span>
              </>
            )}
          </div>

          <hr
            style={{
              border: 'none',
              borderTop: `1px solid ${tokens.color.border}`,
              margin: '2px 0',
            }}
          />

          {/* Client-facing */}
          <div style={{ fontSize: 12, fontWeight: 600, color: tokens.color.textMuted }}>
            CLIENT PORTAL
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={clientVisible}
              onChange={(e) => setClientVisible(e.target.checked)}
            />
            Show this status to clients
          </label>
          <div>
            <span style={labelStyle}>Client label</span>
            <input
              style={inputStyle}
              value={clientLabel}
              onChange={(e) => setClientLabel(e.target.value)}
              placeholder="Shown to clients (falls back to the standard pill if blank)"
            />
          </div>
          <div>
            <span style={labelStyle}>Client description</span>
            <textarea
              style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
              value={clientDescription}
              onChange={(e) => setClientDescription(e.target.value)}
              placeholder="Optional longer message clients see"
            />
          </div>

          <hr
            style={{
              border: 'none',
              borderTop: `1px solid ${tokens.color.border}`,
              margin: '2px 0',
            }}
          />

          {/* 0146 — per-status client notification config */}
          <div style={{ fontSize: 12, fontWeight: 600, color: tokens.color.textMuted }}>
            CLIENT NOTIFICATIONS
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={notifyEnabled}
              onChange={(e) => setNotifyEnabled(e.target.checked)}
            />
            Notify the client when an engagement enters this status
          </label>
          {notifyEnabled && (
            <>
              <div>
                <span style={labelStyle}>Delivery</span>
                <div style={{ display: 'flex', gap: 0 }}>
                  {(
                    [
                      ['STAGED', 'Require approval'],
                      ['IMMEDIATE', 'Send immediately'],
                    ] as const
                  ).map(([value, text], i) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setNotifyMode(value)}
                      style={{
                        padding: '6px 12px',
                        fontSize: 13,
                        cursor: 'pointer',
                        border: `1px solid ${tokens.color.border}`,
                        borderRadius:
                          i === 0
                            ? `${tokens.radius.sm} 0 0 ${tokens.radius.sm}`
                            : `0 ${tokens.radius.sm} ${tokens.radius.sm} 0`,
                        borderLeftWidth: i === 0 ? 1 : 0,
                        background:
                          notifyMode === value ? tokens.color.accentMuted : tokens.color.surface,
                        fontWeight: notifyMode === value ? 600 : 400,
                        color: tokens.color.text,
                      }}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                {notifyMode === 'STAGED' && (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    Queued under Approvals for send-now, schedule, or cancel.
                  </span>
                )}
              </div>
              <div>
                <span style={labelStyle}>Methods</span>
                <div style={{ display: 'flex', gap: 14 }}>
                  {(
                    [
                      ['EMAIL', 'Email'],
                      ['SMS', 'Text message'],
                      ['PORTAL', 'Portal notice'],
                    ] as const
                  ).map(([value, text]) => (
                    <label
                      key={value}
                      style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}
                    >
                      <input
                        type="checkbox"
                        checked={notifyChannels.includes(value)}
                        onChange={(e) =>
                          setNotifyChannels((prev) =>
                            e.target.checked ? [...prev, value] : prev.filter((c) => c !== value),
                          )
                        }
                      />
                      {text}
                    </label>
                  ))}
                </div>
                {notifyChannels.length === 0 && (
                  <span style={{ fontSize: 12, color: tokens.color.warning }}>
                    Pick at least one method or nothing will be sent.
                  </span>
                )}
              </div>
              <div>
                <span style={labelStyle}>Recipients</span>
                <div style={{ display: 'flex', gap: 14 }}>
                  {(
                    [
                      ['BILLING_CONTACT', 'Billing contact'],
                      ['ALL_CONTACTS', 'All contacts'],
                    ] as const
                  ).map(([value, text]) => (
                    <label
                      key={value}
                      style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}
                    >
                      <input
                        type="radio"
                        name="notify-recipients"
                        checked={notifyRecipients === value}
                        onChange={() => setNotifyRecipients(value)}
                      />
                      {text}
                    </label>
                  ))}
                </div>
              </div>
              {!creating && (
                <a
                  href={`/admin/notification-templates?kind=engagement_status:${status!.workflowState}`}
                  style={{ fontSize: 13, color: tokens.color.accent }}
                >
                  Customize message templates →
                </a>
              )}
            </>
          )}

          {error && (
            <div
              style={{
                padding: 10,
                background: 'rgba(220, 38, 38, 0.1)',
                border: `1px solid ${tokens.color.danger}`,
                borderRadius: tokens.radius.sm,
                fontSize: 13,
                color: tokens.color.danger,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              gap: 8,
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              {!creating && !status!.isSystem && (
                <Button variant="ghost" disabled={busy} onClick={() => void remove()}>
                  Delete
                </Button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="secondary" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || !label.trim()}
                onClick={() => void submit()}
              >
                {busy ? 'Saving…' : creating ? 'Create' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
