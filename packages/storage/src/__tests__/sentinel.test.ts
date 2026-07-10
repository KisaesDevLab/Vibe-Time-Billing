// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MockStorageClient } from '../mock';
import {
  readSentinel,
  sentinelKey,
  updateSentinel,
  writeSentinel,
  type SentinelV1,
} from '../sentinel';

const FIRM_A = '11111111-1111-1111-1111-111111111111';
const FIRM_B = '22222222-2222-2222-2222-222222222222';
const CLIENT_X = '33333333-3333-3333-3333-333333333333';
const CLIENT_Y = '44444444-4444-4444-4444-444444444444';
const USER = '55555555-5555-5555-5555-555555555555';

function payload(overrides: Partial<SentinelV1> = {}): SentinelV1 {
  return {
    version: 1,
    client_id: CLIENT_X,
    firm_id: FIRM_A,
    tax_software_id: 'UT-0042',
    display_name_at_creation: 'Smith, John & Mary',
    created_at: '2026-05-21T12:00:00.000Z',
    created_by: USER,
    ...overrides,
  };
}

describe('sentinelKey', () => {
  it('joins folder + sentinel folder + file with forward slashes', () => {
    expect(sentinelKey('Smith, John & Mary/')).toBe('Smith, John & Mary/_Vibe/client.json');
  });

  it('honors custom sentinel folder + file names', () => {
    expect(sentinelKey('Acme/', { folder: '_x', file: 'id.json' })).toBe('Acme/_x/id.json');
  });
});

describe('writeSentinel + readSentinel round-trip', () => {
  let root: string;
  let client: MockStorageClient;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vibe-sentinel-'));
    client = new MockStorageClient({ rootPath: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a sentinel and reads it back intact', async () => {
    const original = payload();
    const writeResult = await writeSentinel(client, 'Smith/', original);
    expect(writeResult.etag).toMatch(/^[0-9a-f]{64}$/);

    const read = await readSentinel(client, 'Smith/', { expectedFirmId: FIRM_A });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.payload).toEqual(original);
      expect(read.etag).toBe(writeResult.etag);
    }
  });

  it('returns reason=missing when the sentinel does not exist', async () => {
    const read = await readSentinel(client, 'Empty/');
    expect(read).toEqual({ ok: false, reason: 'missing' });
  });

  it('returns reason=unparseable when the file is not JSON', async () => {
    await client.put(sentinelKey('Broken/'), Buffer.from('not json {', 'utf8'));
    const read = await readSentinel(client, 'Broken/');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('unparseable');
  });

  it('returns reason=schema_invalid when JSON parses but schema mismatches', async () => {
    await client.put(
      sentinelKey('Bad/'),
      Buffer.from(JSON.stringify({ version: 2, client_id: 'not-a-uuid' }), 'utf8'),
    );
    const read = await readSentinel(client, 'Bad/');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('schema_invalid');
  });

  it('returns reason=wrong_firm when firm_id mismatches expectedFirmId', async () => {
    await writeSentinel(client, 'Other/', payload({ firm_id: FIRM_B }));
    const read = await readSentinel(client, 'Other/', { expectedFirmId: FIRM_A });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toBe('wrong_firm');
      if (read.reason === 'wrong_firm') {
        expect(read.payload.firm_id).toBe(FIRM_B);
      }
    }
  });

  it('writeSentinel rejects payloads that fail schema validation', async () => {
    const bad = { ...payload(), client_id: 'not-a-uuid' } as unknown as SentinelV1;
    await expect(writeSentinel(client, 'Smith/', bad)).rejects.toThrow();
  });
});

describe('updateSentinel', () => {
  let root: string;
  let client: MockStorageClient;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vibe-sentinel-update-'));
    client = new MockStorageClient({ rootPath: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('updates display_name_at_creation while preserving client_id', async () => {
    await writeSentinel(client, 'Smith/', payload());
    const result = await updateSentinel(client, 'Smith/', {
      display_name_at_creation: 'Smith Family Trust',
    });
    expect(result.payload.display_name_at_creation).toBe('Smith Family Trust');
    expect(result.payload.client_id).toBe(CLIENT_X);

    const read = await readSentinel(client, 'Smith/');
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.payload.display_name_at_creation).toBe('Smith Family Trust');
      expect(read.payload.client_id).toBe(CLIENT_X);
    }
  });

  it('refuses to mutate client_id', async () => {
    await writeSentinel(client, 'Smith/', payload());
    await expect(
      // reason: intentionally bypassing the compile-time guard to test
      // the runtime check.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateSentinel(client, 'Smith/', { client_id: CLIENT_Y } as any),
    ).rejects.toThrow(/client_id is immutable/);

    // Storage state must be unchanged.
    const read = await readSentinel(client, 'Smith/');
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.payload.client_id).toBe(CLIENT_X);
  });

  it('throws when the sentinel does not exist yet', async () => {
    await expect(
      updateSentinel(client, 'NoSuchFolder/', { display_name_at_creation: 'X' }),
    ).rejects.toThrow(/cannot update.*missing/);
  });

  it('throws when the sentinel is unparseable', async () => {
    await client.put(sentinelKey('Broken/'), Buffer.from('garbage', 'utf8'));
    await expect(
      updateSentinel(client, 'Broken/', { display_name_at_creation: 'X' }),
    ).rejects.toThrow(/unparseable/);
  });
});
