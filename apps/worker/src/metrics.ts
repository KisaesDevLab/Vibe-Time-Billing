// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Lightweight in-process metrics for the storage workers (Phase 12 of
// FILE_MANAGER_ADDENDUM.md). The appliance is single-process per
// service so a counter map kept in module state is enough; no separate
// metrics library, no Prometheus client lib. Exposes a tiny
// `renderPrometheusText()` that the worker health server serves on
// /metrics.
//
// Metric naming follows the addendum §10 (Observability) list:
//
//   storage_sync_duration_seconds      — last sync tick's wall clock
//   storage_sync_events_total          — by event_type
//   storage_files_inserted_total       — by source (explorer|app|generated)
//   storage_files_updated_total
//   storage_files_soft_deleted_total
//   storage_files_undeleted_total
//   storage_files_hashed_total
//   storage_pending_uploads_swept_total
//   storage_folder_renames_total       — by outcome (ok|failed|lock_lost|...)
//   storage_folder_rename_duration_seconds

const counters = new Map<string, number>();
const gauges = new Map<string, number>();
const histograms = new Map<string, { sum: number; count: number; latestSeconds: number }>();

function labelString(labels: Record<string, string | number> | undefined): string {
  if (!labels) return '';
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const inside = entries.map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, '_')}"`).join(',');
  return `{${inside}}`;
}

function keyFor(name: string, labels?: Record<string, string | number>): string {
  return `${name}${labelString(labels)}`;
}

export function incCounter(name: string, labels?: Record<string, string | number>, by = 1): void {
  const key = keyFor(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function setGauge(
  name: string,
  value: number,
  labels?: Record<string, string | number>,
): void {
  gauges.set(keyFor(name, labels), value);
}

export function observeDurationSeconds(
  name: string,
  seconds: number,
  labels?: Record<string, string | number>,
): void {
  const key = keyFor(name, labels);
  const prev = histograms.get(key) ?? { sum: 0, count: 0, latestSeconds: 0 };
  histograms.set(key, {
    sum: prev.sum + seconds,
    count: prev.count + 1,
    latestSeconds: seconds,
  });
}

const COUNTER_HELP: Record<string, string> = {
  storage_sync_events_total: 'Folder-level sync events emitted, by event_type.',
  storage_files_inserted_total: 'Files inserted by the sync worker, by source.',
  storage_files_updated_total: 'Files updated (etag/size diff) by the sync worker.',
  storage_files_soft_deleted_total: 'Files soft-deleted by the sync worker.',
  storage_files_undeleted_total: 'Files undeleted by the sync worker.',
  storage_files_hashed_total: 'Files hashed by the hash-file worker.',
  storage_pending_uploads_swept_total: 'Stale pending_upload rows hard-deleted by the janitor.',
  storage_folder_renames_total: 'Folder-rename jobs, by outcome.',
};

const HISTOGRAM_HELP: Record<string, string> = {
  storage_sync_duration_seconds: 'Wall-clock duration of the last sync tick.',
  storage_folder_rename_duration_seconds: 'Wall-clock duration of folder-rename jobs.',
};

const GAUGE_HELP: Record<string, string> = {
  storage_hash_pending_files: 'Files waiting on SHA-256 computation (sha256 IS NULL).',
  storage_pending_uploads_open: 'pending_upload rows currently open (not yet completed).',
};

/**
 * Serializes the current metric state in Prometheus exposition format
 * (text version 0.0.4). Histograms are simplified to `_sum`, `_count`,
 * and a gauge-style `_latest_seconds` rather than buckets — bucket
 * tuning isn't worth the wire-format cost for an in-process appliance
 * tracker that already exposes the latest value.
 */
export function renderPrometheusText(): string {
  const out: string[] = [];

  const counterNames = new Set<string>();
  for (const key of counters.keys()) counterNames.add(metricNameFromKey(key));
  for (const name of counterNames) {
    if (COUNTER_HELP[name]) out.push(`# HELP ${name} ${COUNTER_HELP[name]}`);
    out.push(`# TYPE ${name} counter`);
    for (const [key, val] of counters.entries()) {
      if (metricNameFromKey(key) === name) out.push(`${key} ${val}`);
    }
  }

  const gaugeNames = new Set<string>();
  for (const key of gauges.keys()) gaugeNames.add(metricNameFromKey(key));
  for (const name of gaugeNames) {
    if (GAUGE_HELP[name]) out.push(`# HELP ${name} ${GAUGE_HELP[name]}`);
    out.push(`# TYPE ${name} gauge`);
    for (const [key, val] of gauges.entries()) {
      if (metricNameFromKey(key) === name) out.push(`${key} ${val}`);
    }
  }

  const histogramNames = new Set<string>();
  for (const key of histograms.keys()) histogramNames.add(metricNameFromKey(key));
  for (const name of histogramNames) {
    if (HISTOGRAM_HELP[name]) out.push(`# HELP ${name} ${HISTOGRAM_HELP[name]}`);
    // Type 'summary' best fits sum/count without explicit quantiles.
    out.push(`# TYPE ${name} summary`);
    for (const [key, h] of histograms.entries()) {
      if (metricNameFromKey(key) === name) {
        const labels = key.slice(name.length);
        out.push(`${name}_sum${labels} ${h.sum}`);
        out.push(`${name}_count${labels} ${h.count}`);
        out.push(`${name}_latest_seconds${labels} ${h.latestSeconds}`);
      }
    }
  }

  return out.join('\n') + '\n';
}

function metricNameFromKey(key: string): string {
  const brace = key.indexOf('{');
  return brace < 0 ? key : key.slice(0, brace);
}

/** Test seam — drops every metric. Not used in production. */
export function _resetMetricsForTests(): void {
  counters.clear();
  gauges.clear();
  histograms.clear();
}
