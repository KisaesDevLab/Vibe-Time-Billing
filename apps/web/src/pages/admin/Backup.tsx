// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type Frequency = 'daily' | 'every_2_days' | 'weekly';

interface BackupConfig {
  enabled: boolean;
  frequency: Frequency;
  timeOfDayUtc: string;
  retentionDays: number;
  destinationPath: string;
  includeAppKeys: boolean;
  keyBundleKeep: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

interface Recommendation {
  frequency: Frequency;
  retentionDays: number;
  keyBundleKeep: number;
  text: string;
}

interface BackupRun {
  id: string;
  kind: string;
  status: string;
  destinationPath: string | null;
  dbFile: string | null;
  dbBytes: number | null;
  keysFile: string | null;
  keysBytes: number | null;
  retentionDays: number | null;
  prunedCount: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface Destination {
  path: string;
  fstype: string | null;
  device: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  mounted: boolean;
}

const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: 'Daily',
  every_2_days: 'Every 2 days',
  weekly: 'Weekly',
};

const CUSTOM_DEST = '__custom__';

function fmtBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function statusTone(status: string): 'success' | 'danger' | 'warning' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'warning';
  return 'neutral';
}

export function BackupPage(): JSX.Element {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [customDest, setCustomDest] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadDestinations = useCallback(async (): Promise<Destination[]> => {
    const d = await api<{ destinations: Destination[] }>('/api/staff/admin/backup/destinations');
    setDestinations(d.destinations);
    return d.destinations;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const c = await api<{
        config: BackupConfig | null;
        nextRunAt: string | null;
        recommendation: Recommendation;
      }>('/api/staff/admin/backup/config');
      setConfig(c.config);
      setNextRunAt(c.nextRunAt);
      setRecommendation(c.recommendation);
      const dests = await loadDestinations();
      // If the saved destination isn't a discoverable mount, start in custom mode.
      if (c.config && !dests.some((d) => d.path === c.config?.destinationPath)) {
        setCustomDest(true);
      }
      const r = await api<{ runs: BackupRun[] }>('/api/staff/admin/backup/runs');
      setRuns(r.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }, [loadDestinations]);

  async function rescan(): Promise<void> {
    setScanning(true);
    try {
      await loadDestinations();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'rescan_failed');
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  function patch<K extends keyof BackupConfig>(key: K, value: BackupConfig[K]): void {
    setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function save(): Promise<void> {
    if (!config) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/staff/admin/backup/config', {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: config.enabled,
          frequency: config.frequency,
          timeOfDayUtc: config.timeOfDayUtc,
          retentionDays: Number(config.retentionDays),
          destinationPath: config.destinationPath,
          includeAppKeys: config.includeAppKeys,
          keyBundleKeep: Number(config.keyBundleKeep),
        }),
      });
      setNotice('Schedule saved.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function runNow(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('/api/staff/admin/backup/trigger', { method: 'POST', body: '{}' });
      setNotice('Backup requested — it runs on the next executor tick (within ~5 minutes).');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'trigger_failed');
    } finally {
      setBusy(false);
    }
  }

  const labelStyle = { fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 };

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <Card title="Backup schedule">
        {recommendation && (
          <div
            style={{
              fontSize: 13,
              color: tokens.color.text,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              padding: 12,
              marginBottom: tokens.space.md,
            }}
          >
            💡 {recommendation.text}
          </div>
        )}

        {!config ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>
        ) : (
          <div style={{ display: 'grid', gap: tokens.space.md }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => patch('enabled', e.target.checked)}
              />
              Run scheduled backups
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.md }}>
              <div>
                <div style={labelStyle}>Frequency</div>
                <select
                  value={config.frequency}
                  onChange={(e) => patch('frequency', e.target.value as Frequency)}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '10px 12px',
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    fontSize: 14,
                  }}
                >
                  {(Object.keys(FREQUENCY_LABELS) as Frequency[]).map((f) => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABELS[f]}
                      {recommendation?.frequency === f ? ' (recommended)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <Input
                label="Run at (UTC, HH:MM)"
                value={config.timeOfDayUtc}
                onChange={(e) => patch('timeOfDayUtc', e.target.value)}
                placeholder="02:00"
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.md }}>
              <Input
                label="Retention (days)"
                type="number"
                min={1}
                max={3650}
                value={String(config.retentionDays)}
                onChange={(e) => patch('retentionDays', Number(e.target.value))}
                hint={
                  recommendation ? `Recommended: ${recommendation.retentionDays} days` : undefined
                }
              />
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                  }}
                >
                  <div style={labelStyle}>Destination drive</div>
                  <button
                    type="button"
                    onClick={() => void rescan()}
                    disabled={scanning}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: tokens.color.accent,
                      cursor: 'pointer',
                      fontSize: 12,
                      padding: 0,
                    }}
                  >
                    {scanning ? 'Scanning…' : '↻ Rescan drives'}
                  </button>
                </div>
                <select
                  value={customDest ? CUSTOM_DEST : config.destinationPath}
                  onChange={(e) => {
                    if (e.target.value === CUSTOM_DEST) {
                      setCustomDest(true);
                    } else {
                      setCustomDest(false);
                      patch('destinationPath', e.target.value);
                    }
                  }}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '10px 12px',
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    fontSize: 14,
                  }}
                >
                  {destinations.map((d) => (
                    <option key={d.path} value={d.path}>
                      {d.path}
                      {d.mounted && d.freeBytes != null
                        ? ` — ${fmtBytes(d.freeBytes)} free${d.fstype ? ` (${d.fstype})` : ''}`
                        : d.mounted
                          ? ''
                          : ' — not mounted'}
                    </option>
                  ))}
                  <option value={CUSTOM_DEST}>Custom path…</option>
                </select>
                {customDest && (
                  <div style={{ marginTop: 8 }}>
                    <Input
                      value={config.destinationPath}
                      onChange={(e) => patch('destinationPath', e.target.value)}
                      placeholder="/mnt/backup-drive"
                      hint="Mount the drive on the host under /mnt or /media, then Rescan."
                    />
                  </div>
                )}
              </div>
            </div>

            {nextRunAt && config.enabled && (
              <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: 0 }}>
                Next scheduled run: <strong>{fmtDate(nextRunAt)}</strong>
              </p>
            )}

            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Button onClick={() => void save()} disabled={busy}>
                {busy ? 'Saving…' : 'Save schedule'}
              </Button>
              <Button variant="secondary" onClick={() => void runNow()} disabled={busy}>
                Run backup now
              </Button>
            </div>
          </div>
        )}
        {notice && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginTop: 8 }}>{notice}</p>
        )}
        {error && <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>{error}</p>}
      </Card>

      {config && (
        <Card title="App keys (restore dependency)">
          <div
            style={{
              fontSize: 13,
              color: tokens.color.text,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.warning}`,
              borderRadius: tokens.radius.md,
              padding: 12,
              marginBottom: tokens.space.md,
            }}
          >
            ⚠️ The database stores Stripe, email, SMS and webhook secrets{' '}
            <strong>encrypted under the appliance master key (KMS_KEY)</strong>. A database backup
            alone cannot be restored to a working appliance — without the master key and the session
            signing keys, every encrypted column is unreadable. Keep an app-key backup alongside the
            database dump.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={config.includeAppKeys}
              onChange={(e) => patch('includeAppKeys', e.target.checked)}
            />
            Also back up the app keys (KMS_KEY, JWT signing secrets, DB password)
          </label>
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 8 }}>
            The key bundle is written as an <strong>encrypted</strong> archive (
            <code>vibe-tb-keys-*.tar.gz.gpg</code>). The encryption passphrase is supplied to the
            backup container via the <code>BACKUP_KEYS_PASSPHRASE</code> environment variable — it
            is never stored on the appliance (it is also one of the secrets being backed up, so
            storing it here would be circular). Record it in your password manager; you need it to
            restore. If the passphrase is not configured, the database backup still runs and the key
            bundle is skipped (recorded as such in the run log).
          </p>
          <div style={{ marginTop: 8 }}>
            <Input
              label="Encrypted key bundles to keep"
              type="number"
              min={1}
              max={365}
              value={String(config.keyBundleKeep)}
              onChange={(e) => patch('keyBundleKeep', Number(e.target.value))}
              hint={recommendation ? `Recommended: ${recommendation.keyBundleKeep}` : undefined}
              style={{ maxWidth: 200 }}
            />
          </div>
        </Card>
      )}

      {config && (
        <Card title="Last run">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            {config.lastStatus ? (
              <Pill tone={statusTone(config.lastStatus)}>{config.lastStatus}</Pill>
            ) : (
              <Pill tone="neutral">never run</Pill>
            )}
            <span style={{ fontSize: 13, color: tokens.color.textMuted }}>
              last attempt {fmtDate(config.lastRunAt)} · last success{' '}
              {fmtDate(config.lastSuccessAt)}
            </span>
          </div>
          {config.lastError && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 8 }}>
              {config.lastError}
            </p>
          )}
        </Card>
      )}

      <Card title="Run history">
        {runs.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No backups recorded yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: tokens.color.textMuted }}>
                  <th style={{ padding: '6px 8px' }}>Started</th>
                  <th style={{ padding: '6px 8px' }}>Kind</th>
                  <th style={{ padding: '6px 8px' }}>Status</th>
                  <th style={{ padding: '6px 8px' }}>DB size</th>
                  <th style={{ padding: '6px 8px' }}>Keys</th>
                  <th style={{ padding: '6px 8px' }}>Pruned</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
                    <td style={{ padding: '6px 8px' }}>{fmtDate(r.startedAt)}</td>
                    <td style={{ padding: '6px 8px' }}>{r.kind}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <Pill tone={statusTone(r.status)}>{r.status}</Pill>
                      {r.error && (
                        <div style={{ color: tokens.color.danger, fontSize: 11 }}>{r.error}</div>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{fmtBytes(r.dbBytes)}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {r.keysFile ? fmtBytes(r.keysBytes) : '—'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>{r.prunedCount ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 12 }}>
          For the restore procedure, see <code>ops/docs/restore.md</code>.
        </p>
      </Card>
    </div>
  );
}
