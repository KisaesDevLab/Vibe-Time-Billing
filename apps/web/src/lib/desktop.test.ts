// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import { deepLinkToPath, isDesktop, looksLikeUltraTax } from './desktop';
import { DEFAULT_DESKTOP_SETTINGS, inQuietHours, shouldNotify } from './desktop-settings';
import { extractClientIdFromTitle } from '../timer/DesktopTimerBridge';

describe('desktop bridge helpers', () => {
  it('isDesktop is false without the Tauri global', () => {
    expect(isDesktop()).toBe(false);
  });

  it('maps vibetb:// deep links to SPA paths and rejects external redirects', () => {
    expect(deepLinkToPath('vibetb://requests/123')).toBe('/requests/123');
    expect(deepLinkToPath('vibetb:///messages?tab=team')).toBe('/messages?tab=team');
    expect(deepLinkToPath('VIBETB://clients/abc')).toBe('/clients/abc');
    // Extra slashes collapse to an in-app path — never an external navigation.
    expect(deepLinkToPath('vibetb:////evil.example')).toBe('/evil.example');
    expect(deepLinkToPath('https://evil.example')).toBeNull();
  });

  it('recognises UltraTax windows', () => {
    expect(looksLikeUltraTax({ title: 'UltraTax CS 2025 - 1040', appName: 'UT25' })).toBe(true);
    expect(looksLikeUltraTax({ title: 'Spreadsheet', appName: 'Excel' })).toBe(false);
  });

  it('extracts a Client ID token from an UltraTax title', () => {
    expect(extractClientIdFromTitle('UltraTax CS 2025 — 1040 — SMITH01 Smith, John')).toBe(
      'SMITH01',
    );
    expect(extractClientIdFromTitle('UltraTax CS 2025 - 1120S - ACME-LLC')).toBe('ACME-LLC');
    expect(extractClientIdFromTitle('UltraTax CS 2025')).toBeNull();
  });
});

describe('desktop settings', () => {
  it('quiet hours handle windows that cross midnight', () => {
    const s = { ...DEFAULT_DESKTOP_SETTINGS, quietFrom: '22:00', quietTo: '07:00' };
    expect(inQuietHours(s, new Date(2026, 0, 1, 23, 0))).toBe(true);
    expect(inQuietHours(s, new Date(2026, 0, 1, 3, 0))).toBe(true);
    expect(inQuietHours(s, new Date(2026, 0, 1, 12, 0))).toBe(false);
    const day = { ...DEFAULT_DESKTOP_SETTINGS, quietFrom: '09:00', quietTo: '17:00' };
    expect(inQuietHours(day, new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(inQuietHours(day, new Date(2026, 0, 1, 20, 0))).toBe(false);
  });

  it('shouldNotify honours master switch and per-category mute', () => {
    expect(shouldNotify(DEFAULT_DESKTOP_SETTINGS, 'message')).toBe(true);
    expect(
      shouldNotify({ ...DEFAULT_DESKTOP_SETTINGS, notificationsEnabled: false }, 'message'),
    ).toBe(false);
    expect(shouldNotify({ ...DEFAULT_DESKTOP_SETTINGS, mutedCategories: ['team'] }, 'team')).toBe(
      false,
    );
  });
});
