// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

import { describe, it, expect } from 'vitest';

import {
  enforceKeyByteCap,
  isSentinelPath,
  joinPath,
  MAX_BASENAME_BYTES,
  MAX_KEY_BYTES,
  resolveCollision,
  sanitizeForWindows,
  splitClientFolder,
} from '../paths';

describe('joinPath', () => {
  it('joins simple segments', () => {
    expect(joinPath('a', 'b', 'c')).toBe('a/b/c');
  });
  it('preserves trailing slash on last segment', () => {
    expect(joinPath('a', 'b/')).toBe('a/b/');
  });
  it('drops trailing slash when last segment has none', () => {
    expect(joinPath('a/', 'b')).toBe('a/b');
  });
  it('normalizes backslashes', () => {
    expect(joinPath('a\\b', 'c')).toBe('a/b/c');
  });
  it('collapses duplicate slashes', () => {
    expect(joinPath('a//b', '/c/')).toBe('a/b/c/');
  });
  it('skips empty segments', () => {
    expect(joinPath('a', '', 'b')).toBe('a/b');
  });
  it('returns empty for all-empty input', () => {
    expect(joinPath('', '')).toBe('');
  });
});

describe('splitClientFolder', () => {
  it('splits a deeply-nested key', () => {
    const out = splitClientFolder('Smith, John & Mary/Invoices/2024.pdf');
    expect(out.clientFolderPath).toBe('Smith, John & Mary/');
    expect(out.subPath).toBe('Invoices/2024.pdf');
  });
  it('handles a file at the root', () => {
    const out = splitClientFolder('orphan.pdf');
    expect(out.clientFolderPath).toBe('');
    expect(out.subPath).toBe('orphan.pdf');
  });
  it('normalizes backslashes before splitting', () => {
    const out = splitClientFolder('Smith\\Receipts\\r.pdf');
    expect(out.clientFolderPath).toBe('Smith/');
    expect(out.subPath).toBe('Receipts/r.pdf');
  });
  it('strips leading slashes', () => {
    const out = splitClientFolder('/Smith/foo.pdf');
    expect(out.clientFolderPath).toBe('Smith/');
    expect(out.subPath).toBe('foo.pdf');
  });
});

describe('isSentinelPath', () => {
  it('matches the canonical sentinel layout', () => {
    expect(isSentinelPath('Smith/_Vibe/client.json', '_Vibe', 'client.json')).toBe(true);
  });
  it('matches with backslash separators', () => {
    expect(isSentinelPath('Smith\\_Vibe\\client.json', '_Vibe', 'client.json')).toBe(true);
  });
  it('rejects sibling files', () => {
    expect(isSentinelPath('Smith/_Vibe/notes.txt', '_Vibe', 'client.json')).toBe(false);
  });
  it('rejects non-sentinel folder', () => {
    expect(isSentinelPath('Smith/_Other/client.json', '_Vibe', 'client.json')).toBe(false);
  });
});

describe('sanitizeForWindows', () => {
  it('preserves a clean basename', () => {
    expect(sanitizeForWindows('Invoice 2024.pdf')).toBe('Invoice 2024.pdf');
  });
  it('strips forbidden chars', () => {
    expect(sanitizeForWindows('Invoice<draft>.pdf')).toBe('Invoice_draft_.pdf');
  });
  it('replaces colons', () => {
    expect(sanitizeForWindows('Status: Final.pdf')).toBe('Status_ Final.pdf');
  });
  it('strips control chars', () => {
    expect(sanitizeForWindows('Line\nbreak.pdf')).toBe('Linebreak.pdf');
  });
  it('trims trailing dots', () => {
    expect(sanitizeForWindows('weird...')).toBe('weird');
  });
  it('trims trailing spaces', () => {
    expect(sanitizeForWindows('trail   ')).toBe('trail');
  });
  it('underscores reserved device names', () => {
    expect(sanitizeForWindows('CON.txt')).toBe('_CON.txt');
    expect(sanitizeForWindows('NUL')).toBe('_NUL');
    expect(sanitizeForWindows('com1.log')).toBe('_com1.log');
  });
  it('leaves non-reserved similar names alone', () => {
    expect(sanitizeForWindows('CONversation.txt')).toBe('CONversation.txt');
  });
  it('treats embedded slashes as separators (replaced with _)', () => {
    expect(sanitizeForWindows('a/b.pdf')).toBe('a_b.pdf');
    expect(sanitizeForWindows('a\\b.pdf')).toBe('a_b.pdf');
  });
  it('returns _ for fully-stripped input', () => {
    expect(sanitizeForWindows('  ...')).toBe('_');
    expect(sanitizeForWindows('')).toBe('_');
  });
  it('respects the byte cap while preserving extension', () => {
    const long = 'x'.repeat(MAX_BASENAME_BYTES + 50) + '.pdf';
    const out = sanitizeForWindows(long);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_BASENAME_BYTES);
    expect(out.endsWith('.pdf')).toBe(true);
  });
  it('counts multibyte characters correctly', () => {
    // Emoji is 4 bytes in UTF-8.
    const long = '🐳'.repeat(MAX_BASENAME_BYTES) + '.pdf';
    const out = sanitizeForWindows(long);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_BASENAME_BYTES);
  });
});

describe('resolveCollision', () => {
  it('returns the desired key when free', async () => {
    const out = await resolveCollision('Inv.pdf', async () => false);
    expect(out).toBe('Inv.pdf');
  });
  it('appends (2) on first collision', async () => {
    const taken = new Set(['Inv.pdf']);
    const out = await resolveCollision('Inv.pdf', async (k) => taken.has(k));
    expect(out).toBe('Inv (2).pdf');
  });
  it('finds the next free suffix', async () => {
    const taken = new Set(['Inv.pdf', 'Inv (2).pdf', 'Inv (3).pdf']);
    const out = await resolveCollision('Inv.pdf', async (k) => taken.has(k));
    expect(out).toBe('Inv (4).pdf');
  });
  it('handles extensionless basenames', async () => {
    const taken = new Set(['README']);
    const out = await resolveCollision('README', async (k) => taken.has(k));
    expect(out).toBe('README (2)');
  });
  it('handles nested keys (preserves directory)', async () => {
    const taken = new Set(['Smith/Invoices/Inv.pdf']);
    const out = await resolveCollision('Smith/Invoices/Inv.pdf', async (k) => taken.has(k));
    expect(out).toBe('Smith/Invoices/Inv (2).pdf');
  });
  it('throws after 999 attempts', async () => {
    await expect(resolveCollision('x.pdf', async () => true)).rejects.toThrow();
  });
});

describe('enforceKeyByteCap', () => {
  it('returns the same key when within budget', () => {
    expect(enforceKeyByteCap('a/b/c.pdf')).toBe('a/b/c.pdf');
  });
  it('truncates oversized basenames while keeping extension', () => {
    const long = 'a/' + 'x'.repeat(MAX_KEY_BYTES + 50) + '.pdf';
    const out = enforceKeyByteCap(long);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(MAX_KEY_BYTES);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(out.startsWith('a/')).toBe(true);
  });
  it('throws if the directory + extension alone exceed the cap', () => {
    const dir = 'a/'.repeat(MAX_KEY_BYTES); // way too deep
    expect(() => enforceKeyByteCap(`${dir}x.pdf`)).toThrow();
  });
});
