// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Operations → System. Appliance health at a glance: the drive the
// appliance lives on (size + used), RAM, and processor. Auto-refreshes
// every 30s while open.

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, tokens } from '@vibe/ui';

import { api } from '../../api-client';

interface SystemInfo {
  disk: { totalBytes: number; usedBytes: number; availableBytes: number } | null;
  memory: { totalBytes: number; usedBytes: number };
  cpu: { model: string; cores: number; loadAvg: number[] };
  uptimeSeconds: number;
}

function gb(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return g >= 100 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`;
}

function uptimeLabel(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function UsageBar({ used, total }: { used: number; total: number }): JSX.Element {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const tone =
    pct >= 90 ? tokens.color.danger : pct >= 75 ? tokens.color.warning : tokens.color.accent;
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        height: 8,
        borderRadius: 4,
        background: tokens.color.bg,
        border: `1px solid ${tokens.color.border}`,
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: tone }} />
    </div>
  );
}

function Stat({
  label,
  headline,
  detail,
  bar,
}: {
  label: string;
  headline: string;
  detail?: string;
  bar?: { used: number; total: number };
}): JSX.Element {
  return (
    <div
      style={{
        flex: '1 1 220px',
        minWidth: 200,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        padding: '12px 14px',
        display: 'grid',
        gap: 6,
        alignContent: 'start',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: tokens.color.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 700 }}>{headline}</div>
      {bar && <UsageBar used={bar.used} total={bar.total} />}
      {detail && <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{detail}</div>}
    </div>
  );
}

export function SystemInfoPage(): JSX.Element {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api<SystemInfo>('/api/staff/admin/system-info'));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  const diskPct =
    info?.disk && info.disk.totalBytes > 0
      ? Math.round((info.disk.usedBytes / info.disk.totalBytes) * 100)
      : null;
  const memPct = info ? Math.round((info.memory.usedBytes / info.memory.totalBytes) * 100) : null;

  return (
    <Card
      title="System"
      action={
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          Refresh
        </Button>
      }
    >
      <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
        The appliance host: drive the app resides on, memory, and processor. Refreshes every 30
        seconds.
      </p>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 13 }}>
          Could not load system info — try Refresh.
        </p>
      )}
      {info && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.md }}>
          <Stat
            label="Drive"
            headline={
              info.disk
                ? `${gb(info.disk.usedBytes)} of ${gb(info.disk.totalBytes)} used${diskPct != null ? ` (${diskPct}%)` : ''}`
                : 'unavailable'
            }
            bar={info.disk ? { used: info.disk.usedBytes, total: info.disk.totalBytes } : undefined}
            detail={info.disk ? `${gb(info.disk.availableBytes)} free for the app` : undefined}
          />
          <Stat
            label="Memory (RAM)"
            headline={`${gb(info.memory.usedBytes)} of ${gb(info.memory.totalBytes)} used${memPct != null ? ` (${memPct}%)` : ''}`}
            bar={{ used: info.memory.usedBytes, total: info.memory.totalBytes }}
          />
          <Stat
            label="Processor"
            headline={`${info.cpu.cores} cores`}
            detail={`${info.cpu.model} — load ${info.cpu.loadAvg.join(' / ')} (1/5/15 min) — up ${uptimeLabel(info.uptimeSeconds)}`}
          />
        </div>
      )}
      {!info && !error && <p style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</p>}
    </Card>
  );
}
