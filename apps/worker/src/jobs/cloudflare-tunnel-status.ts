// SPDX-License-Identifier: Elastic-2.0
//
// 0085 — Cloudflare Tunnel status poller. Once per minute we hit the
// sidecar's local metrics endpoints (default http://cloudflared:2000)
// and write a snapshot to cloudflare_tunnel_config.metrics_snapshot.
//
// Two probes:
//   GET /ready    — returns 200 + JSON when at least one connector is
//                   registered. Body shape: { status, connectorId, ... }.
//   GET /metrics  — Prometheus text format. We scrape
//                   `cloudflared_tunnel_ha_connections` for connector
//                   count. (Region/IP labels are present but vary
//                   across cloudflared versions, so we keep parsing
//                   tolerant.)
//
// If the sidecar isn't reachable we still write a snapshot with
// ready=false so the UI can render "tunnel offline".

import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import type { Database } from '@vibe/db';
import { cloudflareTunnelConfigs } from '@vibe/db/schema';

export interface CloudflaredFetch {
  (url: string): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }>;
}

export interface CloudflareTunnelStatusResult {
  scanned: number;
  updated: number;
  reachable: number;
}

interface MetricsSnapshot {
  ready: boolean;
  connectorCount: number;
  region: string | null;
  checkedAt: string;
}

const METRIC_NAME = 'cloudflared_tunnel_ha_connections';

export function parseConnectorCount(promText: string): {
  count: number;
  region: string | null;
} {
  // Find lines like:
  //   cloudflared_tunnel_ha_connections{location="lax01",tunnel_id="..."} 1
  // Sum the values (each connection registers as a separate sample).
  let count = 0;
  let region: string | null = null;
  for (const line of promText.split(/\r?\n/)) {
    if (!line.startsWith(METRIC_NAME)) continue;
    if (line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    if (space < 0) continue;
    const value = Number(line.slice(space + 1));
    if (Number.isFinite(value)) count += value;
    if (!region) {
      const locMatch = /location="([^"]+)"/.exec(line);
      if (locMatch) region = locMatch[1] ?? null;
    }
  }
  return { count, region };
}

export async function runCloudflareTunnelStatusTick(
  db: Database,
  log: Logger,
  args: { metricsUrl?: string; fetchImpl?: CloudflaredFetch },
  now = new Date(),
): Promise<CloudflareTunnelStatusResult> {
  const result: CloudflareTunnelStatusResult = {
    scanned: 0,
    updated: 0,
    reachable: 0,
  };
  const rows = await db
    .select({
      id: cloudflareTunnelConfigs.id,
      firmId: cloudflareTunnelConfigs.firmId,
      status: cloudflareTunnelConfigs.status,
    })
    .from(cloudflareTunnelConfigs);
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const metricsUrl =
    args.metricsUrl ?? process.env['CLOUDFLARED_METRICS_URL'] ?? 'http://cloudflared:2000';
  const fetchImpl: CloudflaredFetch =
    args.fetchImpl ?? (globalThis as unknown as { fetch: CloudflaredFetch }).fetch;

  // The sidecar is shared across all tunnels for this appliance (single-
  // firm), so we hit the metrics endpoint once and write the same
  // snapshot to every row.
  let snapshot: MetricsSnapshot;
  try {
    const [readyRes, metricsRes] = await Promise.all([
      fetchImpl(`${metricsUrl}/ready`).catch(() => null),
      fetchImpl(`${metricsUrl}/metrics`).catch(() => null),
    ]);
    const ready = Boolean(readyRes?.ok);
    const promText = metricsRes && metricsRes.ok ? await metricsRes.text() : '';
    const { count, region } = parseConnectorCount(promText);
    snapshot = {
      ready,
      connectorCount: count,
      region,
      checkedAt: now.toISOString(),
    };
    if (ready) result.reachable = rows.length;
  } catch (err) {
    log.warn({ err }, 'cf tunnel status: probe failed');
    snapshot = {
      ready: false,
      connectorCount: 0,
      region: null,
      checkedAt: now.toISOString(),
    };
  }

  for (const row of rows) {
    if (row.status === 'INACTIVE') continue;
    await db
      .update(cloudflareTunnelConfigs)
      .set({ metricsSnapshot: snapshot, lastStatusCheckAt: now })
      .where(eq(cloudflareTunnelConfigs.id, row.id));
    result.updated += 1;
  }
  return result;
}
