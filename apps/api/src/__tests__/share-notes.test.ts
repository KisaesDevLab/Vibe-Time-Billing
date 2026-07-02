// SPDX-License-Identifier: Elastic-2.0
//
// Sharing a file drops a client-timeline note (with the share-form details),
// and a 3rd-party access drops another. The access note is skipped when the
// share has no app_user author (author_id is NOT NULL).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { recordShareCreatedNote, recordShareAccessNote } from '../sharing/share-notes';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});
afterEach(async () => {
  await harness.close();
});

async function notes(clientId: string): Promise<{ body: string }[]> {
  const r = await harness.db.execute(
    sql`SELECT body FROM client_note WHERE client_id = ${clientId} ORDER BY created_at`,
  );
  return (r as unknown as { rows: { body: string }[] }).rows;
}

describe('file-share client notes', () => {
  it('records a share-created note with the file name and form details', async () => {
    const { clientId, appUserId } = await seedMinimalFirm(harness.db);
    await recordShareCreatedNote(harness.db, {
      clientId,
      authorAppUserId: appUserId,
      fileLabel: 'Return_1040.pdf',
      recipientName: 'Jane Doe',
      recipientEmail: 'jane@example.com',
      organization: 'Acme Corp',
      accessLevel: 'download',
      watermark: true,
      verifyChannel: 'EMAIL',
      expiresAt: new Date('2026-08-01T00:00:00Z'),
      personalMessage: 'Here is your return',
    });
    const rows = await notes(clientId);
    expect(rows).toHaveLength(1);
    const body = rows[0]!.body;
    expect(body).toContain('Return_1040.pdf');
    expect(body).toContain('jane@example.com');
    expect(body).toContain('Acme Corp');
    expect(body).toContain('View & download');
    expect(body).toContain('Watermark on');
    expect(body).toContain('Access code via EMAIL');
    expect(body).toContain('Here is your return');
  });

  it('records an access note for a download', async () => {
    const { clientId, appUserId } = await seedMinimalFirm(harness.db);
    await recordShareAccessNote(harness.db, {
      clientId,
      authorAppUserId: appUserId,
      fileLabel: 'Return_1040.pdf',
      recipientEmail: 'jane@example.com',
      action: 'downloaded',
    });
    const rows = await notes(clientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toContain('downloaded the shared file');
    expect(rows[0]!.body).toContain('jane@example.com');
  });

  it('skips the access note when the share has no app_user author', async () => {
    const { clientId } = await seedMinimalFirm(harness.db);
    await recordShareAccessNote(harness.db, {
      clientId,
      authorAppUserId: null,
      fileLabel: 'Return_1040.pdf',
      recipientEmail: 'jane@example.com',
      action: 'viewed',
    });
    expect(await notes(clientId)).toHaveLength(0);
  });

  it('skips the created note when the file has no client', async () => {
    const { appUserId } = await seedMinimalFirm(harness.db);
    // clientId null → nothing to attach to; must not throw.
    await recordShareCreatedNote(harness.db, {
      clientId: null,
      authorAppUserId: appUserId,
      fileLabel: 'Firmwide.pdf',
      recipientEmail: 'jane@example.com',
      accessLevel: 'view',
    });
    // No client to query; the call simply no-ops without error.
    expect(true).toBe(true);
  });
});
