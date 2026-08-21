// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Portal request detail — 0084. Lets a client see items + attachments,
// type a reply, flip status to NEEDS_INFO, or mark the whole request
// fulfilled. Per-item fulfill comes from the staff "checklist" mode.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../api-client';

// Browser-safe binary → base64 (chunked; atob/btoa choke on big buffers).
function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface RequestRow {
  id: string;
  engagementId: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  dueDate: string | null;
  fulfilledAt: string | null;
  clientReplyText: string | null;
  createdAt: string;
}

interface RequestItem {
  id: string;
  ordinal: number;
  label: string;
  body: string;
  itemKind: 'QUESTION' | 'DOCUMENT' | 'SIGNATURE';
  required: boolean;
  status: string;
  fulfilledText: string | null;
}

interface Attachment {
  id: string;
  fileId: string;
  fileName: string | null;
  fileSize: number | null;
  uploadedAt: string;
}

function statusTone(s: string): 'success' | 'warning' | 'neutral' | 'accent' {
  switch (s) {
    case 'FULFILLED':
      return 'success';
    case 'OPEN':
      return 'warning';
    case 'NEEDS_INFO':
      return 'accent';
    default:
      return 'neutral';
  }
}

export function RequestDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = params.id ?? '';
  const [request, setRequest] = useState<RequestRow | null>(null);
  const [items, setItems] = useState<RequestItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [needsInfo, setNeedsInfo] = useState('');
  const [perItemText, setPerItemText] = useState<Record<string, string>>({});

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<{
        request: RequestRow;
        items: RequestItem[];
        attachments: Attachment[];
      }>(`/api/portal/requests/${id}`);
      setRequest(r.request);
      setItems(r.items ?? []);
      setAttachments(r.attachments ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }

  useEffect(() => {
    if (id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function sendReply(): Promise<void> {
    if (!reply.trim()) return;
    setBusy('reply');
    try {
      await api(`/api/portal/requests/${id}/reply`, {
        method: 'POST',
        body: JSON.stringify({ text: reply.trim() }),
      });
      setReply('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reply_failed');
    } finally {
      setBusy(null);
    }
  }

  async function sendNeedsInfo(): Promise<void> {
    if (!needsInfo.trim()) return;
    setBusy('needs-info');
    try {
      await api(`/api/portal/requests/${id}/needs-info`, {
        method: 'POST',
        body: JSON.stringify({ text: needsInfo.trim() }),
      });
      setNeedsInfo('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'needs_info_failed');
    } finally {
      setBusy(null);
    }
  }

  // 0220 — direct upload against a DOCUMENT item. One call stores the
  // file with your firm (in the folder they chose) and ticks the item.
  const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
  async function uploadForItem(itemId: string, file: File): Promise<void> {
    if (file.size > UPLOAD_MAX_BYTES) {
      setError(`"${file.name}" is larger than the 20 MB upload limit.`);
      return;
    }
    setBusy(itemId);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      await api(`/api/portal/requests/${id}/items/${itemId}/upload`, {
        method: 'POST',
        body: JSON.stringify({
          originalFilename: file.name,
          mimeType: file.type || undefined,
          contentBase64: bufferToBase64(buf),
        }),
      });
      await load();
    } catch (err) {
      setError(
        err instanceof Error && err.message === 'file_too_large'
          ? `"${file.name}" is larger than the 20 MB upload limit.`
          : 'Upload failed — please try again or contact your firm.',
      );
    } finally {
      setBusy(null);
    }
  }

  async function fulfillItem(itemId: string): Promise<void> {
    setBusy(itemId);
    try {
      const text = perItemText[itemId]?.trim() || undefined;
      await api(`/api/portal/requests/${id}/items/${itemId}/fulfill`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      setPerItemText((m) => ({ ...m, [itemId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'fulfill_item_failed');
    } finally {
      setBusy(null);
    }
  }

  async function markComplete(): Promise<void> {
    setBusy('complete');
    try {
      await api(`/api/portal/requests/${id}/fulfill`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'complete_failed');
    } finally {
      setBusy(null);
    }
  }

  if (!request) {
    return (
      <Card>
        <p style={{ fontSize: 13 }}>{error ?? 'Loading…'}</p>
      </Card>
    );
  }

  const allRequiredDone =
    items.length > 0 && items.every((i) => !i.required || i.status === 'FULFILLED');

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg }}>
      <div>
        <Button variant="ghost" onClick={() => navigate('/requests')}>
          ← Back to requests
        </Button>
      </div>

      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>{request.title}</h2>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <Pill tone={statusTone(request.status)}>{request.status}</Pill>
              {request.dueDate && <Pill tone="neutral">due {request.dueDate}</Pill>}
            </div>
            {request.body && (
              <p style={{ fontSize: 13, marginTop: 12, whiteSpace: 'pre-wrap' }}>{request.body}</p>
            )}
          </div>
          {request.status === 'OPEN' && (items.length === 0 || allRequiredDone) && (
            <Button onClick={() => void markComplete()} disabled={busy === 'complete'}>
              Mark complete
            </Button>
          )}
        </div>
      </Card>

      {items.length > 0 && (
        <Card title="Checklist">
          <div style={{ display: 'grid', gap: 6 }}>
            {items.map((it) => (
              <div
                key={it.id}
                style={{
                  padding: 10,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{it.label}</div>
                  <Pill>{it.itemKind}</Pill>
                  {it.required && <Pill tone="warning">required</Pill>}
                  <Pill tone={statusTone(it.status)}>{it.status}</Pill>
                </div>
                {it.body && (
                  <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
                    {it.body}
                  </p>
                )}
                {it.fulfilledText && (
                  <p style={{ fontSize: 12, color: tokens.color.success, margin: 0 }}>
                    Your reply: {it.fulfilledText}
                  </p>
                )}
                {it.status !== 'FULFILLED' && it.itemKind === 'DOCUMENT' && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 13,
                        fontWeight: 600,
                        color: tokens.color.accent,
                        cursor: busy ? 'wait' : 'pointer',
                      }}
                    >
                      {busy === it.id ? 'Uploading…' : '⬆ Upload document'}
                      <input
                        type="file"
                        disabled={busy !== null || request.status === 'FULFILLED'}
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) void uploadForItem(it.id, f);
                        }}
                      />
                    </label>
                    <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                      lands directly with your firm — no separate attach step
                    </span>
                  </div>
                )}
                {it.status !== 'FULFILLED' && it.itemKind !== 'DOCUMENT' && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={perItemText[it.id] ?? ''}
                      onChange={(e) => setPerItemText((m) => ({ ...m, [it.id]: e.target.value }))}
                      placeholder={
                        it.itemKind === 'QUESTION' ? 'Your answer (optional)' : 'Optional note'
                      }
                      style={{ flex: 1, padding: tokens.space.sm }}
                    />
                    <Button
                      size="sm"
                      onClick={() => void fulfillItem(it.id)}
                      disabled={busy === it.id}
                    >
                      Mark done
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {attachments.length > 0 && (
        <Card title={`Attachments (${attachments.length})`}>
          <ul style={{ paddingLeft: 18, fontSize: 13 }}>
            {attachments.map((a) => (
              <li key={a.id}>
                {a.fileName ?? a.fileId}
                {a.fileSize ? ` — ${Math.round(a.fileSize / 1024)} KB` : ''}
                <span style={{ color: tokens.color.textMuted, marginLeft: 6 }}>
                  ({new Date(a.uploadedAt).toLocaleDateString()})
                </span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 11, color: tokens.color.textMuted }}>
            Uploaded documents go straight to your firm — nothing else to do here.
          </p>
        </Card>
      )}

      {request.status !== 'FULFILLED' && request.status !== 'DISMISSED' && (
        <Card title="Reply">
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={3}
            placeholder="Type a reply to send to your firm…"
            style={{ width: '100%', padding: tokens.space.sm }}
          />
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <Button onClick={() => void sendReply()} disabled={busy === 'reply' || !reply.trim()}>
              Send reply
            </Button>
          </div>
          {request.clientReplyText && (
            <div
              style={{
                marginTop: 12,
                padding: 8,
                background: tokens.color.surface,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 12,
                whiteSpace: 'pre-wrap',
              }}
            >
              <strong>Your last reply:</strong> {request.clientReplyText}
            </div>
          )}
        </Card>
      )}

      {request.status === 'OPEN' && (
        <Card title="Need more info?">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            Send your firm a question and flip this request back to &ldquo;needs info&rdquo; so it
            doesn&apos;t sit as still-open on their end.
          </p>
          <textarea
            value={needsInfo}
            onChange={(e) => setNeedsInfo(e.target.value)}
            rows={3}
            placeholder="What's blocking you?"
            style={{ width: '100%', padding: tokens.space.sm, marginTop: 6 }}
          />
          <div style={{ marginTop: 6 }}>
            <Button
              variant="secondary"
              onClick={() => void sendNeedsInfo()}
              disabled={busy === 'needs-info' || !needsInfo.trim()}
            >
              Send question
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
