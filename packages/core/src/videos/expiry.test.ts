// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { DAY_MS, computeVideoExpiresAt, videoProgressPct } from './expiry';

const uploadedAt = new Date('2026-09-01T12:00:00Z');

describe('computeVideoExpiresAt', () => {
  it('uses the upload clock alone before first play', () => {
    const r = computeVideoExpiresAt({
      uploadedAt,
      firstPlayedAt: null,
      deleteAfterDays: 30,
      deleteDaysAfterFirstPlay: 3,
    });
    expect(r?.getTime()).toBe(uploadedAt.getTime() + 30 * DAY_MS);
  });

  it('takes the earlier clock once played', () => {
    const firstPlayedAt = new Date(uploadedAt.getTime() + 5 * DAY_MS);
    const r = computeVideoExpiresAt({
      uploadedAt,
      firstPlayedAt,
      deleteAfterDays: 30,
      deleteDaysAfterFirstPlay: 3,
    });
    expect(r?.getTime()).toBe(firstPlayedAt.getTime() + 3 * DAY_MS);
  });

  it('keeps the upload clock when it is still earlier than play + M', () => {
    const firstPlayedAt = new Date(uploadedAt.getTime() + 29 * DAY_MS);
    const r = computeVideoExpiresAt({
      uploadedAt,
      firstPlayedAt,
      deleteAfterDays: 30,
      deleteDaysAfterFirstPlay: 3,
    });
    expect(r?.getTime()).toBe(uploadedAt.getTime() + 30 * DAY_MS);
  });

  it('returns null when both clocks are disabled', () => {
    expect(
      computeVideoExpiresAt({
        uploadedAt,
        firstPlayedAt: new Date(),
        deleteAfterDays: null,
        deleteDaysAfterFirstPlay: null,
      }),
    ).toBeNull();
  });

  it('ignores the play clock while unplayed even if the upload clock is off', () => {
    expect(
      computeVideoExpiresAt({
        uploadedAt,
        firstPlayedAt: null,
        deleteAfterDays: null,
        deleteDaysAfterFirstPlay: 3,
      }),
    ).toBeNull();
  });
});

describe('videoProgressPct', () => {
  it('rounds and clamps', () => {
    expect(videoProgressPct(30, 120)).toBe(25);
    expect(videoProgressPct(130, 120)).toBe(100);
    expect(videoProgressPct(-1, 120)).toBe(0);
  });
  it('guards missing or zero duration', () => {
    expect(videoProgressPct(30, 0)).toBeNull();
    expect(videoProgressPct(30, null)).toBeNull();
    expect(videoProgressPct(null, 120)).toBeNull();
  });
});
