// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetMetricsForTests,
  incCounter,
  observeDurationSeconds,
  renderPrometheusText,
  setGauge,
} from '../metrics';

describe('metrics', () => {
  beforeEach(() => {
    _resetMetricsForTests();
  });

  it('increments counters with no labels', () => {
    incCounter('storage_files_hashed_total');
    incCounter('storage_files_hashed_total', undefined, 3);
    const out = renderPrometheusText();
    expect(out).toContain('storage_files_hashed_total 4');
  });

  it('increments counters with labels', () => {
    incCounter('storage_sync_events_total', { event_type: 'discovered' });
    incCounter('storage_sync_events_total', { event_type: 'discovered' });
    incCounter('storage_sync_events_total', { event_type: 'renamed' });
    const out = renderPrometheusText();
    expect(out).toMatch(/storage_sync_events_total\{event_type="discovered"\} 2/);
    expect(out).toMatch(/storage_sync_events_total\{event_type="renamed"\} 1/);
  });

  it('serializes gauges', () => {
    setGauge('storage_hash_pending_files', 17);
    const out = renderPrometheusText();
    expect(out).toContain('storage_hash_pending_files 17');
    expect(out).toContain('# TYPE storage_hash_pending_files gauge');
  });

  it('overwrites a gauge on subsequent set', () => {
    setGauge('storage_pending_uploads_open', 5);
    setGauge('storage_pending_uploads_open', 0);
    const out = renderPrometheusText();
    expect(out).toContain('storage_pending_uploads_open 0');
    expect(out).not.toContain('storage_pending_uploads_open 5');
  });

  it('records histogram observations as summary sum/count/latest', () => {
    observeDurationSeconds('storage_sync_duration_seconds', 1.2);
    observeDurationSeconds('storage_sync_duration_seconds', 0.8);
    const out = renderPrometheusText();
    expect(out).toMatch(/storage_sync_duration_seconds_sum 2/);
    expect(out).toMatch(/storage_sync_duration_seconds_count 2/);
    expect(out).toMatch(/storage_sync_duration_seconds_latest_seconds 0.8/);
    expect(out).toMatch(/# TYPE storage_sync_duration_seconds summary/);
  });

  it('emits HELP lines for known metric names', () => {
    incCounter('storage_pending_uploads_swept_total');
    const out = renderPrometheusText();
    expect(out).toMatch(/# HELP storage_pending_uploads_swept_total/);
  });

  it('escapes dangerous characters in label values', () => {
    incCounter('storage_sync_events_total', { event_type: 'a"b\nc' });
    const out = renderPrometheusText();
    // Quote, newline, and backslash should all be sanitized to underscore.
    expect(out).toContain('storage_sync_events_total{event_type="a_b_c"} 1');
  });
});
