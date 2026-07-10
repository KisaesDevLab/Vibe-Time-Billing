// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0159 — Per-client credential vault card. Secrets are encrypted at rest on
// the server; the list shows metadata only. Revealing a secret calls the
// reveal endpoint, which requires a fresh step-up (TOTP) and is audited.
// Plaintext is held only transiently in component state and cleared on hide.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../../api-client';

interface CredentialMeta {
  id: string;
  title: string;
  category: string;
  hint: string | null;
  hasPassword: boolean;
  hasUrl: boolean;
  lastRevealedAt: string | null;
  createdAt: string;
}

interface RevealedSecret {
  username: string | null;
  password: string | null;
  url: string | null;
  notes: string | null;
}

interface Props {
  clientId: string;
}

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'irs', label: 'IRS e-Services' },
  { value: 'state', label: 'State portal' },
  { value: 'bank', label: 'Bank' },
  { value: 'payroll', label: 'Payroll' },
  { value: 'software', label: 'Software' },
  { value: 'other', label: 'Other' },
];

const fieldStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
  width: '100%',
};

function categoryLabel(v: string): string {
  return CATEGORIES.find((c) => c.value === v)?.label ?? v;
}

function generatePassword(len = 20): string {
  // Avoid ambiguous chars (0/O, 1/l/I).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_';
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => chars[x % chars.length]).join('');
}

interface FormState {
  id: string | null; // null = creating; set = editing
  title: string;
  category: string;
  username: string;
  password: string;
  url: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  title: '',
  category: 'other',
  username: '',
  password: '',
  url: '',
  notes: '',
};

export function ClientCredentialsCard({ clientId }: Props): JSX.Element {
  const [items, setItems] = useState<CredentialMeta[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, RevealedSecret>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const r = await api<{ items: CredentialMeta[] }>(
        `/api/staff/clients/${clientId}/credentials`,
      );
      setItems(r.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    setRevealed({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  function openCreate(): void {
    setForm({ ...EMPTY_FORM });
    setShowPassword(false);
    setError(null);
  }

  function openEdit(c: CredentialMeta): void {
    // Secrets are never prefilled; leave blank to keep, type to rotate.
    setForm({
      id: c.id,
      title: c.title,
      category: c.category,
      username: '',
      password: '',
      url: '',
      notes: '',
    });
    setShowPassword(false);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!form || !form.title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (form.id) {
        // Update: only send changed secret fields (blank = keep).
        const body: Record<string, unknown> = { title: form.title.trim(), category: form.category };
        if (form.username) body['username'] = form.username;
        if (form.password) body['password'] = form.password;
        if (form.url) body['url'] = form.url;
        if (form.notes) body['notes'] = form.notes;
        await api(`/api/staff/clients/${clientId}/credentials/${form.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      } else {
        await api(`/api/staff/clients/${clientId}/credentials`, {
          method: 'POST',
          body: JSON.stringify({
            title: form.title.trim(),
            category: form.category,
            username: form.username || null,
            password: form.password || null,
            url: form.url || null,
            notes: form.notes || null,
          }),
        });
      }
      setForm(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function reveal(c: CredentialMeta): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      const secret = await api<RevealedSecret>(
        `/api/staff/clients/${clientId}/credentials/${c.id}/reveal`,
        { method: 'POST' },
      );
      setRevealed((prev) => ({ ...prev, [c.id]: secret }));
      await load(); // refresh last-revealed
    } catch (e) {
      const code = (e as ApiError)?.body
        ? String(((e as ApiError).body as { error?: string }).error ?? '')
        : '';
      setError(
        code === 'step_up_required'
          ? 'Reveal needs a fresh second-factor verification. Verify in Account → Two-factor, then try again.'
          : code === 'vault_unavailable'
            ? 'The vault is locked. Unlock the appliance to reveal credentials.'
            : e instanceof Error
              ? e.message
              : 'reveal_failed',
      );
    }
  }

  function hide(id: string): void {
    setRevealed((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function copy(text: string | null | undefined, label: string): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${label} copied.`);
    } catch {
      setError('Copy failed — select and copy manually.');
    }
  }

  async function archive(c: CredentialMeta): Promise<void> {
    if (!confirm(`Archive "${c.title}"?`)) return;
    try {
      await api(`/api/staff/clients/${clientId}/credentials/${c.id}`, { method: 'DELETE' });
      hide(c.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'archive_failed');
    }
  }

  return (
    <Card
      title={`Credentials (${items.length})`}
      action={
        <Button size="sm" variant="secondary" onClick={() => (form ? setForm(null) : openCreate())}>
          {form ? 'Cancel' : '+ Add credential'}
        </Button>
      }
    >
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        Stored encrypted on this appliance. Revealing a password requires a fresh second-factor
        verification and is recorded in the audit log.
      </p>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 8 }} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p style={{ color: tokens.color.success, fontSize: 12, marginBottom: 8 }}>{notice}</p>
      )}

      {form && (
        <div style={{ display: 'grid', gap: 8, marginBottom: 14 }}>
          <input
            style={fieldStyle}
            placeholder="Name (e.g. IRS e-Services)"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            aria-label="Credential name"
          />
          <select
            style={fieldStyle}
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            aria-label="Category"
          >
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            style={fieldStyle}
            placeholder={form.id ? 'Username (leave blank to keep)' : 'Username'}
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            aria-label="Username"
            autoComplete="off"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ ...fieldStyle, flex: 1 }}
              type={showPassword ? 'text' : 'password'}
              placeholder={form.id ? 'Password (leave blank to keep)' : 'Password'}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              aria-label="Password"
              autoComplete="new-password"
            />
            <Button size="sm" variant="ghost" onClick={() => setShowPassword((s) => !s)}>
              {showPassword ? 'Hide' : 'Show'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setForm({ ...form, password: generatePassword() });
                setShowPassword(true);
              }}
            >
              Generate
            </Button>
          </div>
          <input
            style={fieldStyle}
            placeholder="URL (optional)"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            aria-label="URL"
          />
          <textarea
            style={{ ...fieldStyle, resize: 'vertical', minHeight: 56 }}
            placeholder={form.id ? 'Notes (leave blank to keep)' : 'Notes (optional)'}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            aria-label="Notes"
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" onClick={() => void save()} disabled={busy || !form.title.trim()}>
              {busy ? 'Saving…' : form.id ? 'Save changes' : 'Add'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No credentials yet.</p>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map((c) => {
            const sec = revealed[c.id];
            return (
              <div
                key={c.id}
                style={{
                  padding: 10,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.md,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{c.title}</span>
                  <Pill tone="neutral">{categoryLabel(c.category)}</Pill>
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {c.hint ?? (c.hasPassword ? '••••••••' : '—')}
                  </span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {sec ? (
                      <Button size="sm" variant="ghost" onClick={() => hide(c.id)}>
                        Hide
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => void reveal(c)}>
                        Reveal
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void archive(c)}>
                      Archive
                    </Button>
                  </div>
                </div>
                {sec && (
                  <div
                    style={{
                      display: 'grid',
                      gap: 4,
                      fontSize: 13,
                      fontFamily: tokens.font.mono,
                      background: tokens.color.surface,
                      borderRadius: tokens.radius.sm,
                      padding: 8,
                    }}
                  >
                    <RevealRow
                      label="Username"
                      value={sec.username}
                      onCopy={() => void copy(sec.username, 'Username')}
                    />
                    <RevealRow
                      label="Password"
                      value={sec.password}
                      onCopy={() => void copy(sec.password, 'Password')}
                    />
                    {sec.url && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span style={{ color: tokens.color.textMuted, minWidth: 80 }}>URL</span>
                        <a href={sec.url} target="_blank" rel="noopener noreferrer">
                          {sec.url}
                        </a>
                      </div>
                    )}
                    {sec.notes && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <span style={{ color: tokens.color.textMuted, minWidth: 80 }}>Notes</span>
                        <span style={{ whiteSpace: 'pre-wrap', fontFamily: tokens.font.body }}>
                          {sec.notes}
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {c.lastRevealedAt && (
                  <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                    Last revealed {new Date(c.lastRevealedAt).toLocaleString()}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function RevealRow({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string | null;
  onCopy: () => void;
}): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ color: tokens.color.textMuted, minWidth: 80 }}>{label}</span>
      <span style={{ flex: 1, wordBreak: 'break-all' }}>{value ?? '—'}</span>
      {value && (
        <Button size="sm" variant="ghost" onClick={onCopy}>
          Copy
        </Button>
      )}
    </div>
  );
}
