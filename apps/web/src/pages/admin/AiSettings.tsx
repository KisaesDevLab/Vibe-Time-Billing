// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin > AI & Integrations > AI settings.
//
// Enter per-provider AI keys (Anthropic / OpenAI-compatible / Ollama),
// test them, and control cloud egress. Keys are stored MFK-encrypted and
// only ever shown back as a last-4 hint. Cloud providers require cloud
// egress to be enabled — either "Direct" (appliance calls the provider
// API directly) or "Shield" (route through a reachable Vibe Shield).
//
// Endpoints: GET/PUT/POST/DELETE /api/staff/admin/ai-credentials and
// PATCH /api/staff/admin/firm-config (egress). Gate: firm:settings:write.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type ProviderId = 'anthropic' | 'openai_compatible' | 'ollama';

interface ProviderRow {
  providerId: ProviderId;
  hasKey: boolean;
  keyHint: string | null;
  baseUrl: string | null;
  model: string | null;
  inputCentsPerMtok: number | null;
  outputCentsPerMtok: number | null;
  enabled: boolean;
  status: string;
  lastError: string | null;
  lastTestedAt: string | null;
}

interface EgressState {
  enabled: boolean;
  mode: 'shield' | 'direct';
  shieldEndpoint: string | null;
  shieldReachable: boolean;
}

interface SettingsResp {
  providers: ProviderRow[];
  egress: EgressState | null;
  budget: { monthlyBudgetCents: number; warnThresholdPct: number } | null;
}

interface ProviderMeta {
  id: ProviderId;
  label: string;
  kind: 'cloud' | 'local';
  needsKey: boolean;
  needsBaseUrl: boolean;
  modelPlaceholder: string;
  baseUrlPlaceholder?: string;
  blurb: string;
}

const PROVIDER_META: ProviderMeta[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'cloud',
    needsKey: true,
    needsBaseUrl: false,
    modelPlaceholder: 'claude-opus-4-7',
    blurb: 'Cloud. Requires an API key and cloud egress enabled.',
  },
  {
    id: 'openai_compatible',
    label: 'OpenAI-compatible',
    kind: 'cloud',
    needsKey: false,
    needsBaseUrl: true,
    modelPlaceholder: 'gpt-4o-mini',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
    blurb: 'Cloud or self-hosted (vLLM, Groq, Together, OpenRouter, …). Requires a base URL.',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'local',
    needsKey: false,
    needsBaseUrl: false,
    modelPlaceholder: 'qwen3:8b',
    baseUrlPlaceholder: 'http://localhost:11434',
    blurb: 'Local models. No key and no egress gate.',
  },
];

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
  display: 'block',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: tokens.space.sm,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
};

interface Draft {
  apiKey: string;
  baseUrl: string;
  model: string;
  inputCents: string;
  outputCents: string;
}

const emptyDraft = (): Draft => ({
  apiKey: '',
  baseUrl: '',
  model: '',
  inputCents: '',
  outputCents: '',
});

function statusTone(s: string): 'success' | 'danger' | 'neutral' {
  if (s === 'OK') return 'success';
  if (s === 'ERROR') return 'danger';
  return 'neutral';
}

export function AiSettingsPage(): JSX.Element {
  const [data, setData] = useState<SettingsResp | null>(null);
  const [drafts, setDrafts] = useState<Record<ProviderId, Draft>>({
    anthropic: emptyDraft(),
    openai_compatible: emptyDraft(),
    ollama: emptyDraft(),
  });
  const [egress, setEgress] = useState<EgressState>({
    enabled: false,
    mode: 'shield',
    shieldEndpoint: null,
    shieldReachable: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  async function load(): Promise<void> {
    const r = await api<SettingsResp>('/api/staff/admin/ai-credentials');
    setData(r);
    if (r.egress) setEgress(r.egress);
    setDrafts((prev) => {
      const next = { ...prev };
      for (const m of PROVIDER_META) {
        const row = r.providers.find((p) => p.providerId === m.id);
        next[m.id] = {
          apiKey: '',
          baseUrl: row?.baseUrl ?? '',
          model: row?.model ?? '',
          inputCents: row?.inputCentsPerMtok != null ? String(row.inputCentsPerMtok) : '',
          outputCents: row?.outputCentsPerMtok != null ? String(row.outputCentsPerMtok) : '',
        };
      }
      return next;
    });
  }

  useEffect(() => {
    load().catch((e) =>
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'load failed' }),
    );
  }, []);

  function rowFor(id: ProviderId): ProviderRow | undefined {
    return data?.providers.find((p) => p.providerId === id);
  }

  function setDraft(id: ProviderId, patch: Partial<Draft>): void {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function saveProvider(id: ProviderId): Promise<void> {
    setBusy(`save:${id}`);
    setMsg(null);
    try {
      const d = drafts[id];
      const body: Record<string, unknown> = {
        baseUrl: d.baseUrl.trim() || null,
        model: d.model.trim() || null,
        inputCentsPerMtok: d.inputCents.trim() ? Number(d.inputCents) : null,
        outputCentsPerMtok: d.outputCents.trim() ? Number(d.outputCents) : null,
      };
      if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
      await api(`/api/staff/admin/ai-credentials/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setMsg({ kind: 'ok', text: `Saved ${id}.` });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'save failed' });
    } finally {
      setBusy(null);
    }
  }

  async function testProvider(id: ProviderId): Promise<void> {
    setBusy(`test:${id}`);
    setMsg(null);
    try {
      const d = drafts[id];
      const body: Record<string, unknown> = {};
      if (d.apiKey.trim()) body.apiKey = d.apiKey.trim();
      if (d.baseUrl.trim()) body.baseUrl = d.baseUrl.trim();
      if (d.model.trim()) body.model = d.model.trim();
      const r = await api<{ ok: boolean; error: string | null }>(
        `/api/staff/admin/ai-credentials/${id}/test`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      setMsg(
        r.ok
          ? { kind: 'ok', text: `${id}: connection OK.` }
          : { kind: 'err', text: `${id}: ${r.error ?? 'test failed'}` },
      );
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'test failed' });
    } finally {
      setBusy(null);
    }
  }

  async function removeProvider(id: ProviderId): Promise<void> {
    setBusy(`del:${id}`);
    setMsg(null);
    try {
      await api(`/api/staff/admin/ai-credentials/${id}`, { method: 'DELETE' });
      setMsg({ kind: 'ok', text: `Removed ${id}.` });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'remove failed' });
    } finally {
      setBusy(null);
    }
  }

  async function saveEgress(): Promise<void> {
    setBusy('egress');
    setMsg(null);
    try {
      await api('/api/staff/admin/firm-config', {
        method: 'PATCH',
        body: JSON.stringify({
          aiEgressEnabled: egress.enabled,
          aiEgressMode: egress.mode,
          vibeShieldEndpoint:
            egress.mode === 'shield' ? egress.shieldEndpoint || null : egress.shieldEndpoint,
        }),
      });
      setMsg({ kind: 'ok', text: 'Cloud egress saved.' });
      await load();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'save failed' });
    } finally {
      setBusy(null);
    }
  }

  if (!data) {
    return <div style={{ padding: tokens.space.lg }}>Loading…</div>;
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <div>
        <h2 style={{ margin: 0 }}>AI settings</h2>
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>
          Enter your own AI provider keys. Keys are encrypted at rest and shown back only as the
          last 4 characters. Local-first routing applies: a local model is used when available.
        </p>
      </div>

      {msg && (
        <div
          style={{
            padding: tokens.space.sm,
            borderRadius: tokens.radius.sm,
            background: msg.kind === 'ok' ? '#e6f6ec' : '#fbe9e9',
            color: msg.kind === 'ok' ? tokens.color.text : tokens.color.danger,
            fontSize: 13,
          }}
        >
          {msg.text}
        </div>
      )}

      {/* Cloud egress */}
      <Card>
        <div style={{ display: 'grid', gap: tokens.space.md, padding: tokens.space.md }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>Cloud egress</strong>
            <Pill tone={egress.enabled ? 'success' : 'neutral'}>
              {egress.enabled ? `Enabled · ${egress.mode}` : 'Disabled (local-only)'}
            </Pill>
          </div>
          <p style={{ color: tokens.color.textMuted, fontSize: 13, margin: 0 }}>
            Cloud providers (Anthropic, OpenAI-compatible) only run when cloud egress is enabled.
            <strong> Direct</strong> calls the provider API straight from the appliance.{' '}
            <strong>Shield</strong> requires a reachable Vibe Shield proxy.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input
              type="checkbox"
              checked={egress.enabled}
              onChange={(e) => setEgress({ ...egress, enabled: e.target.checked })}
            />
            Enable cloud AI
          </label>
          <div>
            <span style={labelStyle}>Mode</span>
            <select
              style={{ ...inputStyle, width: 200 }}
              value={egress.mode}
              onChange={(e) =>
                setEgress({ ...egress, mode: e.target.value as 'shield' | 'direct' })
              }
            >
              <option value="direct">Direct (no shield)</option>
              <option value="shield">Shield (proxy)</option>
            </select>
          </div>
          {egress.mode === 'shield' && (
            <div>
              <span style={labelStyle}>
                Vibe Shield endpoint{' '}
                <Pill tone={egress.shieldReachable ? 'success' : 'danger'}>
                  {egress.shieldReachable ? 'reachable' : 'unreachable'}
                </Pill>
              </span>
              <input
                style={inputStyle}
                placeholder="https://shield.example.com"
                value={egress.shieldEndpoint ?? ''}
                onChange={(e) => setEgress({ ...egress, shieldEndpoint: e.target.value })}
              />
            </div>
          )}
          {data.budget && (
            <p style={{ color: tokens.color.textMuted, fontSize: 12, margin: 0 }}>
              Monthly budget cap: ${(data.budget.monthlyBudgetCents / 100).toFixed(2)} (warn at{' '}
              {data.budget.warnThresholdPct}%). Edit under Firm settings.
            </p>
          )}
          <div>
            <Button onClick={() => void saveEgress()} disabled={busy === 'egress'}>
              {busy === 'egress' ? 'Saving…' : 'Save egress'}
            </Button>
          </div>
        </div>
      </Card>

      {/* Provider cards */}
      {PROVIDER_META.map((m) => {
        const row = rowFor(m.id);
        const d = drafts[m.id];
        return (
          <Card key={m.id}>
            <div style={{ display: 'grid', gap: tokens.space.sm, padding: tokens.space.md }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <strong>{m.label}</strong>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Pill tone={m.kind === 'local' ? 'neutral' : 'accent'}>{m.kind}</Pill>
                  {row && <Pill tone={statusTone(row.status)}>{row.status}</Pill>}
                </div>
              </div>
              <p style={{ color: tokens.color.textMuted, fontSize: 12, margin: 0 }}>{m.blurb}</p>
              {row?.lastError && (
                <p style={{ color: tokens.color.danger, fontSize: 12, margin: 0 }}>
                  Last error: {row.lastError}
                </p>
              )}

              {(m.needsKey || m.id === 'openai_compatible') && (
                <div>
                  <span style={labelStyle}>
                    API key {row?.hasKey ? `(stored: ${row.keyHint})` : ''}
                  </span>
                  <input
                    style={inputStyle}
                    type="password"
                    autoComplete="off"
                    placeholder={row?.hasKey ? 'Leave blank to keep current key' : 'Paste API key'}
                    value={d.apiKey}
                    onChange={(e) => setDraft(m.id, { apiKey: e.target.value })}
                  />
                </div>
              )}

              {(m.needsBaseUrl || m.id === 'ollama') && (
                <div>
                  <span style={labelStyle}>Base URL</span>
                  <input
                    style={inputStyle}
                    placeholder={m.baseUrlPlaceholder}
                    value={d.baseUrl}
                    onChange={(e) => setDraft(m.id, { baseUrl: e.target.value })}
                  />
                </div>
              )}

              <div>
                <span style={labelStyle}>Model</span>
                <input
                  style={inputStyle}
                  placeholder={m.modelPlaceholder}
                  value={d.model}
                  onChange={(e) => setDraft(m.id, { model: e.target.value })}
                />
              </div>

              {m.kind === 'cloud' && (
                <div style={{ display: 'flex', gap: tokens.space.sm }}>
                  <div style={{ flex: 1 }}>
                    <span style={labelStyle}>Input ¢ / 1M tok (optional)</span>
                    <input
                      style={inputStyle}
                      inputMode="numeric"
                      value={d.inputCents}
                      onChange={(e) => setDraft(m.id, { inputCents: e.target.value })}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <span style={labelStyle}>Output ¢ / 1M tok (optional)</span>
                    <input
                      style={inputStyle}
                      inputMode="numeric"
                      value={d.outputCents}
                      onChange={(e) => setDraft(m.id, { outputCents: e.target.value })}
                    />
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: tokens.space.sm, alignItems: 'center' }}>
                <Button onClick={() => void saveProvider(m.id)} disabled={busy === `save:${m.id}`}>
                  {busy === `save:${m.id}` ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void testProvider(m.id)}
                  disabled={busy === `test:${m.id}`}
                >
                  {busy === `test:${m.id}` ? 'Testing…' : 'Test connection'}
                </Button>
                {row && (
                  <Button
                    variant="ghost"
                    onClick={() => void removeProvider(m.id)}
                    disabled={busy === `del:${m.id}`}
                  >
                    Remove
                  </Button>
                )}
                {row?.lastTestedAt && (
                  <span style={{ color: tokens.color.textMuted, fontSize: 12 }}>
                    Last tested {new Date(row.lastTestedAt).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
