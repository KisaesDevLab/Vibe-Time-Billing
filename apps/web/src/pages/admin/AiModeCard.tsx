// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0222 — Admin → AI settings → AI routing. Switch between the appliance
// default (VIBE_AI_MODE env), direct providers, and the Vibe AI Router,
// with the router URL + token stored per firm (token encrypted at rest,
// shown back as a hint) and a "Test connection" that registers this app's
// task classes against the router.

import { useEffect, useState } from 'react';
import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

export interface AiModeConfig {
  setting: 'env' | 'direct' | 'router';
  effective: 'direct' | 'router';
  source: 'env' | 'firm';
  problem: string | null;
  envMode: 'direct' | 'router';
  envRouterUrl: string | null;
  routerUrl: string | null;
  hasToken: boolean;
  tokenHint: string | null;
  status: string;
  lastError: string | null;
  lastTestedAt: string | null;
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  fontSize: 13,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  background: tokens.color.surface,
  color: tokens.color.text,
};
const label: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 4,
};
const hint: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  margin: '4px 0 0',
};

const PROBLEMS: Record<string, string> = {
  router_url_missing: 'Router mode is selected but no router URL is saved.',
  router_token_missing: 'Router mode is selected but no token is saved.',
  appliance_locked:
    'The appliance is sealed; the router token cannot be read until it is unlocked.',
};

export function AiModeCard({
  config,
  onSaved,
}: {
  config: AiModeConfig;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [mode, setMode] = useState(config.setting);
  const [url, setUrl] = useState(config.routerUrl ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    setMode(config.setting);
    setUrl(config.routerUrl ?? '');
  }, [config.setting, config.routerUrl]);

  const dirty = mode !== config.setting || url !== (config.routerUrl ?? '') || token !== '';
  const routerReady = mode !== 'router' || (url.trim() && (token || config.hasToken));

  async function save(): Promise<void> {
    setBusy('save');
    setMsg(null);
    try {
      const body: Record<string, unknown> = { mode };
      if (mode === 'router' || url !== (config.routerUrl ?? '')) body['routerUrl'] = url.trim();
      if (token) body['token'] = token;
      const r = await api<{ effective: string; problem: string | null }>(
        '/api/staff/admin/ai-credentials/ai-mode',
        { method: 'PUT', body: JSON.stringify(body) },
      );
      setToken('');
      setMsg({
        kind: r.problem ? 'err' : 'ok',
        text: r.problem
          ? `Saved, but effective mode is ${r.effective}: ${PROBLEMS[r.problem] ?? r.problem}`
          : `Saved — AI requests now use ${r.effective === 'router' ? 'the Vibe AI Router' : 'direct providers'}.`,
      });
      await onSaved();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'save failed' });
    } finally {
      setBusy(null);
    }
  }

  async function test(): Promise<void> {
    setBusy('test');
    setMsg(null);
    try {
      const body: Record<string, unknown> = {};
      if (url.trim()) body['routerUrl'] = url.trim();
      if (token) body['token'] = token;
      const r = await api<{ ok: boolean; registered?: number; error?: string }>(
        '/api/staff/admin/ai-credentials/ai-mode/test',
        { method: 'POST', body: JSON.stringify(body) },
      );
      setMsg({
        kind: 'ok',
        text: `Router reachable — ${r.registered ?? 0} task classes registered.`,
      });
      await onSaved();
    } catch (e) {
      const err = e as { body?: { error?: string }; message?: string };
      setMsg({
        kind: 'err',
        text: `Router test failed: ${err.body?.error ?? err.message ?? 'error'}`,
      });
      await onSaved();
    } finally {
      setBusy(null);
    }
  }

  const effectiveTone = config.problem
    ? 'warning'
    : config.effective === 'router'
      ? 'accent'
      : 'neutral';

  return (
    <Card title="AI routing">
      <div style={{ display: 'grid', gap: tokens.space.md }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span>Currently:</span>
          <Pill tone={effectiveTone}>
            {config.effective === 'router' ? 'Vibe AI Router' : 'Direct providers'}
          </Pill>
          <span style={{ color: tokens.color.textMuted }}>
            {config.source === 'env' ? '(appliance default)' : '(firm setting)'}
          </span>
        </div>
        {config.problem && (
          <div style={{ fontSize: 13, color: tokens.color.warning }}>
            {PROBLEMS[config.problem] ?? config.problem} Falling back to direct providers.
          </div>
        )}

        <div role="radiogroup" style={{ display: 'grid', gap: 8, fontSize: 13 }}>
          {(
            [
              [
                'env',
                `Appliance default (${config.envMode === 'router' ? 'Vibe AI Router' : 'direct providers'}, from VIBE_AI_MODE)`,
              ],
              ['direct', 'Direct providers — this firm’s own keys, egress policy and budget below'],
              [
                'router',
                'Vibe AI Router — model choice, data boundary and budgets managed per task class in the router console',
              ],
            ] as Array<[AiModeConfig['setting'], string]>
          ).map(([value, text]) => (
            <label
              key={value}
              style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}
            >
              <input
                type="radio"
                name="ai-mode"
                value={value}
                checked={mode === value}
                onChange={() => setMode(value)}
              />
              <span>{text}</span>
            </label>
          ))}
        </div>

        {mode === 'router' && (
          <div
            style={{
              display: 'grid',
              gap: tokens.space.sm,
              padding: tokens.space.md,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
            }}
          >
            <div>
              <span style={label}>Router URL</span>
              <input
                style={inputStyle}
                value={url}
                placeholder={config.envRouterUrl ?? 'https://ai.yourfirm.com'}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div>
              <span style={label}>Access token</span>
              <input
                style={inputStyle}
                type="password"
                value={token}
                placeholder={
                  config.hasToken
                    ? `stored ${config.tokenHint ?? '••••'} — enter to replace`
                    : 'paste the token minted by the router'
                }
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
              <p style={hint}>
                Encrypted at rest with the firm key; only the last 4 characters are shown back.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
              <Pill
                tone={
                  config.status === 'OK'
                    ? 'success'
                    : config.status === 'ERROR'
                      ? 'danger'
                      : 'neutral'
                }
              >
                {config.status}
              </Pill>
              {config.lastTestedAt && (
                <span style={{ color: tokens.color.textMuted }}>
                  tested {new Date(config.lastTestedAt).toLocaleString()}
                </span>
              )}
              {config.lastError && (
                <span style={{ color: tokens.color.danger }}>{config.lastError}</span>
              )}
            </div>
          </div>
        )}

        {msg && (
          <div
            style={{
              fontSize: 13,
              color: msg.kind === 'ok' ? tokens.color.success : tokens.color.danger,
            }}
          >
            {msg.text}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => void save()} disabled={busy !== null || !dirty || !routerReady}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
          {mode === 'router' && (
            <Button
              variant="secondary"
              onClick={() => void test()}
              disabled={busy !== null || !url.trim() || !(token || config.hasToken)}
            >
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </Button>
          )}
        </div>
        <p style={hint}>
          Switching takes effect immediately for new AI requests. Router mode never falls back to a
          direct provider: if the router is unreachable, AI features report an error rather than
          sending data around the router’s policy.
        </p>
      </div>
    </Card>
  );
}
