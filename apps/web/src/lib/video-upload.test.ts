// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import {
  COMPLETE_RETRY_DELAYS_MS,
  VIDEO_MAX_BYTES,
  formatAvailableUntil,
  isMovFile,
  progressPct,
  resolveVideoMime,
  titleFromFilename,
  validateVideoFile,
  videoStatusPill,
} from './video-upload';

const f = (name: string, type: string, size = 1000) => ({ name, type, size });

describe('resolveVideoMime / validateVideoFile', () => {
  it('accepts the three formats by mime or extension', () => {
    expect(resolveVideoMime(f('a.mp4', 'video/mp4'))).toBe('video/mp4');
    expect(resolveVideoMime(f('a.MOV', ''))).toBe('video/quicktime');
    expect(resolveVideoMime(f('a.webm', 'video/webm'))).toBe('video/webm');
    expect(resolveVideoMime(f('a.m4v', 'video/x-m4v'))).toBe('video/mp4');
    expect(resolveVideoMime(f('blob', 'video/quicktime'))).toBe('video/quicktime');
  });
  it('rejects other types, empty files, and files over 2 GiB', () => {
    expect(validateVideoFile(f('a.pdf', 'application/pdf'))).toMatch(/MP4, MOV, or WebM/);
    expect(validateVideoFile(f('a.avi', 'video/x-msvideo'))).toMatch(/MP4, MOV, or WebM/);
    expect(validateVideoFile(f('a.mp4', 'video/mp4', 0))).toMatch(/empty/);
    expect(validateVideoFile(f('a.mp4', 'video/mp4', VIDEO_MAX_BYTES + 1))).toMatch(/2 GB/);
    expect(validateVideoFile(f('a.mp4', 'video/mp4', VIDEO_MAX_BYTES))).toBeNull();
  });
});

describe('helpers', () => {
  it('detects .mov regardless of case or missing mime', () => {
    expect(isMovFile(f('Clip.MOV', ''))).toBe(true);
    expect(isMovFile(f('clip.mp4', 'video/mp4'))).toBe(false);
  });
  it('prefills a title from the filename', () => {
    expect(titleFromFilename('2025_return-walkthrough.mp4')).toBe('2025 return walkthrough');
    expect(titleFromFilename('noext')).toBe('noext');
  });
  it('formats availability', () => {
    expect(formatAvailableUntil(null)).toBe('No expiry');
    expect(formatAvailableUntil('not a date')).toBe('No expiry');
    expect(formatAvailableUntil('2026-10-03T00:00:00Z')).toMatch(/^Until /);
  });
  it('clamps progress and guards zero duration', () => {
    expect(progressPct(30, 120)).toBe(25);
    expect(progressPct(130, 120)).toBe(100);
    expect(progressPct(10, 0)).toBeNull();
    expect(progressPct(null, 100)).toBeNull();
  });
  it('picks status pills', () => {
    expect(videoStatusPill({ status: 'AVAILABLE', firstPlayedAt: null })).toEqual({
      label: 'Not played',
      tone: 'warning',
    });
    expect(
      videoStatusPill({ status: 'AVAILABLE', firstPlayedAt: '2026-09-03T12:00:00Z' }).tone,
    ).toBe('success');
    expect(videoStatusPill({ status: 'EXPIRED', firstPlayedAt: null }).label).toBe('Expired');
  });
  it('has a bounded, non-empty completion retry schedule', () => {
    expect(COMPLETE_RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    const total = COMPLETE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(5000);
    expect(total).toBeLessThan(60_000);
  });
});
