// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin → Document intake. Controls which staff appear on the public intake
// page, their order/title, per-card notification prefs, and headshots.

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api, getCsrfToken, type ApiError } from '../../api-client';

interface Card {
  userId: string;
  name: string;
  active: boolean;
  isVisible: boolean;
  acceptingUploads: boolean;
  displayOrder: number;
  displayTitle: string | null;
  notifyEmail: boolean;
  notifySms: boolean;
  notifyInApp: boolean;
  hasHeadshot: boolean;
}

const cell: React.CSSProperties = { padding: '8px 10px', fontSize: 13, verticalAlign: 'middle' };

export function IntakeSettingsPage(): JSX.Element {
  const [cards, setCards] = useState<Card[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const [cardsRes, settingsRes] = await Promise.all([
        api<{ cards: Card[] }>('/api/staff/admin/intake'),
        api<{ enabled: boolean }>('/api/staff/admin/intake/settings'),
      ]);
      setCards(cardsRes.cards);
      setEnabled(settingsRes.enabled);
    } catch (err) {
      setError((err as ApiError).message);
    }
  }, []);

  async function toggleEnabled(next: boolean): Promise<void> {
    setEnabled(next);
    try {
      await api('/api/staff/admin/intake/settings', {
        method: 'PATCH',
        body: JSON.stringify({ enabled: next }),
      });
    } catch (err) {
      setError((err as ApiError).message);
      setEnabled(!next);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(userId: string, body: Partial<Card>): Promise<void> {
    setSavingId(userId);
    setError(null);
    // optimistic
    setCards((prev) => prev.map((c) => (c.userId === userId ? { ...c, ...body } : c)));
    try {
      await api(`/api/staff/admin/intake/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    } catch (err) {
      setError((err as ApiError).message);
      await load();
    } finally {
      setSavingId(null);
    }
  }

  async function uploadHeadshot(userId: string, file: File): Promise<void> {
    setSavingId(userId);
    try {
      const res = await fetch(
        `/api/staff/admin/intake/${userId}/headshot?mimeType=${encodeURIComponent(file.type)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': file.type, 'X-CSRF-Token': getCsrfToken() ?? '' },
          body: file,
          credentials: 'same-origin',
        },
      );
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <h1 style={{ fontSize: 20, margin: '0 0 6px' }}>Document intake</h1>
      <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 0 }}>
        Choose which staff appear on your public intake page and how they&apos;re notified.
      </p>
      <label
        style={{
          display: 'inline-flex',
          gap: 8,
          alignItems: 'center',
          fontSize: 14,
          padding: '8px 0',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
        Document intake enabled (public page is live when on)
      </label>
      {error && <div style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</div>}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: `1px solid ${tokens.color.border}` }}>
            <th style={cell}>Staff</th>
            <th style={cell}>Visible</th>
            <th style={cell}>Accepting</th>
            <th style={cell}>Title</th>
            <th style={cell}>Order</th>
            <th style={cell}>Email</th>
            <th style={cell}>SMS</th>
            <th style={cell}>Headshot</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr
              key={c.userId}
              style={{
                borderBottom: `1px solid ${tokens.color.border}`,
                opacity: c.active ? 1 : 0.5,
              }}
            >
              <td style={cell}>{c.name}</td>
              <td style={cell}>
                <input
                  type="checkbox"
                  checked={c.isVisible}
                  disabled={savingId === c.userId}
                  onChange={(e) => void patch(c.userId, { isVisible: e.target.checked })}
                />
              </td>
              <td style={cell}>
                <input
                  type="checkbox"
                  checked={c.acceptingUploads}
                  disabled={savingId === c.userId}
                  onChange={(e) => void patch(c.userId, { acceptingUploads: e.target.checked })}
                />
              </td>
              <td style={cell}>
                <input
                  defaultValue={c.displayTitle ?? ''}
                  placeholder="e.g. Tax Manager"
                  onBlur={(e) =>
                    e.target.value !== (c.displayTitle ?? '') &&
                    void patch(c.userId, { displayTitle: e.target.value || null })
                  }
                  style={{
                    padding: 4,
                    fontSize: 13,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    width: 140,
                  }}
                />
              </td>
              <td style={cell}>
                <input
                  type="number"
                  defaultValue={c.displayOrder}
                  onBlur={(e) =>
                    Number(e.target.value) !== c.displayOrder &&
                    void patch(c.userId, { displayOrder: Number(e.target.value) })
                  }
                  style={{
                    padding: 4,
                    fontSize: 13,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.sm,
                    width: 56,
                  }}
                />
              </td>
              <td style={cell}>
                <input
                  type="checkbox"
                  checked={c.notifyEmail}
                  onChange={(e) => void patch(c.userId, { notifyEmail: e.target.checked })}
                />
              </td>
              <td style={cell}>
                <input
                  type="checkbox"
                  checked={c.notifySms}
                  onChange={(e) => void patch(c.userId, { notifySms: e.target.checked })}
                />
              </td>
              <td style={cell}>
                <input
                  ref={(el) => (fileInputs.current[c.userId] = el)}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadHeadshot(c.userId, f);
                    e.target.value = '';
                  }}
                />
                <Button variant="ghost" onClick={() => fileInputs.current[c.userId]?.click()}>
                  {c.hasHeadshot ? 'Replace' : 'Upload'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
