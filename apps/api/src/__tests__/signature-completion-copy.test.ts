// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The completion confirmation used to tell the client "a copy is available
// for your records" without saying how to get one. It now carries a gated,
// expiring download link for the signed copy (an attachment was silently
// dropped on the signatures-poll path, whose mail dispatch has no
// attachments field), or names who to contact when there's no link to give.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildPgliteHarness,
  seedContact,
  seedMinimalFirm,
  type PgliteHarness,
} from './_pglite-harness';
import { clientFolders, files, fileShares } from '@vibe/db/schema';

import { copyNoteFor, notifySignatureCompleted } from '../signatures/completion-notify';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

interface Sent {
  to: string;
  subject: string;
  body: string;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  await seedContact(harness.db, {
    firmId: seed.firmId,
    clientId: seed.clientId,
    fullName: 'Dana Ruiz',
    email: 'dana@example.com',
    isBilling: true,
  });
});
afterEach(async () => {
  await harness.close();
});

/** A files row standing in for the auto-filed signed copy. */
async function seedSignedFile(): Promise<string> {
  const [folder] = await harness.db
    .insert(clientFolders)
    .values({ firmId: seed.firmId, clientId: seed.clientId, storagePath: 'Test Client Co' })
    .returning({ id: clientFolders.id });
  const [row] = await harness.db
    .insert(files)
    .values({
      firmId: seed.firmId,
      clientId: seed.clientId,
      clientFolderId: folder!.id,
      subfolderPath: 'Signatures/',
      originalFilename: 'Engagement Letter (signed).pdf',
      storageKey: 'Test Client Co/Signatures/Engagement Letter (signed).pdf',
      mimeType: 'application/pdf',
      sizeBytes: 11,
      source: 'signature',
    })
    .returning({ id: files.id });
  return row!.id;
}

function requestInfo() {
  return {
    id: seed.clientId, // any uuid; the notifier only echoes it
    firmId: seed.firmId,
    clientId: seed.clientId,
    engagementId: null,
    createdBy: seed.appUserId,
    title: 'Engagement Letter',
  };
}

describe('signature completion confirmation', () => {
  it('mints a download link for the filed signed copy', async () => {
    const fileId = await seedSignedFile();
    const sent: Sent[] = [];
    await notifySignatureCompleted(
      harness.db,
      requestInfo(),
      ['signer@example.com'],
      async (a) => {
        sent.push(a);
      },
      fileId,
      'https://portal.test',
    );

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe('dana@example.com');
    expect(mail.body).toContain('Download your signed copy here:');
    expect(mail.body).toContain('https://portal.test/shared/file/');
    expect(mail.body).toContain('access code');
    // The old copy promised a copy and left the client with no next step.
    expect(mail.body).not.toContain('A copy is available for your records.');

    // A real, gated, download-level share pointing at that file.
    const shares = await harness.db.select().from(fileShares);
    expect(shares).toHaveLength(1);
    expect(shares[0]!.fileId).toBe(fileId);
    expect(shares[0]!.accessLevel).toBe('download');
    expect(shares[0]!.gated).toBe(true);
    expect(shares[0]!.recipientEmail).toBe('dana@example.com');
    // The emailed token must match the share row it was minted from.
    const token = /shared\/file\/(\S+)/.exec(mail.body)![1]!;
    expect(token.split('.')[0]).toBe(shares[0]!.id);
  });

  it('tells the client who to contact when there is no filed copy to link', async () => {
    const sent: Sent[] = [];
    await notifySignatureCompleted(
      harness.db,
      requestInfo(),
      ['signer@example.com'],
      async (a) => {
        sent.push(a);
      },
      null,
      'https://portal.test',
    );

    expect(sent[0]!.body).toContain('For a copy of the signed document');
    expect(sent[0]!.body).not.toContain('/shared/file/');
    expect(await harness.db.select().from(fileShares)).toHaveLength(0);
  });

  it('falls back to the contact wording when no portal URL is configured', async () => {
    const fileId = await seedSignedFile();
    const sent: Sent[] = [];
    await notifySignatureCompleted(
      harness.db,
      requestInfo(),
      ['signer@example.com'],
      async (a) => {
        sent.push(a);
      },
      fileId,
      null,
    );

    // No half-built link — a share is not even created.
    expect(sent[0]!.body).toContain('For a copy of the signed document');
    expect(await harness.db.select().from(fileShares)).toHaveLength(0);
  });

  it('renders the firm template through {{ document.copy_note }}', async () => {
    const fileId = await seedSignedFile();
    await harness.db.execute(
      sql`INSERT INTO notification_template (firm_id, kind, channel, subject, body, enabled)
          VALUES (${seed.firmId}, 'signature_complete', 'EMAIL', 'All signed',
                  'Done. {{ document.copy_note }}', true)`,
    );
    const sent: Sent[] = [];
    await notifySignatureCompleted(
      harness.db,
      requestInfo(),
      [],
      async (a) => {
        sent.push(a);
      },
      fileId,
      'https://portal.test',
    );

    expect(sent[0]!.subject).toBe('All signed');
    expect(sent[0]!.body).toContain('Done. Download your signed copy here:');
  });
});

// The seeder is ON CONFLICT DO NOTHING, so firms seeded before this change
// keep the old sentence in their row — 0232 rewrites just that sentence.
describe('migration 0232 — existing template rows', () => {
  const migration = readFileSync(
    join(__dirname, '../../../../packages/db/migrations/0232_signature_complete_copy_note.sql'),
    'utf8',
  );

  it('rewrites the dead-end sentence but leaves a reworded template alone', async () => {
    await harness.db.execute(
      sql`INSERT INTO notification_template (firm_id, kind, channel, subject, body, enabled)
          VALUES (${seed.firmId}, 'signature_complete', 'EMAIL', 'Signed',
                  'Hello, your document is complete. A copy is available for your records. Thanks.',
                  true)`,
    );
    // A firm that reworded the paragraph must not be touched.
    const [otherFirm] = (
      (await harness.db.execute(
        sql`INSERT INTO firm (name) VALUES ('Other Firm') RETURNING id`,
      )) as unknown as { rows: { id: string }[] }
    ).rows;
    await harness.db.execute(
      sql`INSERT INTO notification_template (firm_id, kind, channel, subject, body, enabled)
          VALUES (${otherFirm!.id}, 'signature_complete', 'EMAIL', 'Signed',
                  'All done — we will mail you a copy.', true)`,
    );

    await harness.pglite.exec(migration);

    const rows = (await harness.db.execute(
      sql`SELECT firm_id, body FROM notification_template
          WHERE kind = 'signature_complete' AND channel = 'EMAIL'`,
    )) as unknown as { rows: { firm_id: string; body: string }[] };
    const mine = rows.rows.find((r) => r.firm_id === seed.firmId)!;
    const other = rows.rows.find((r) => r.firm_id === otherFirm!.id)!;

    expect(mine.body).toBe('Hello, your document is complete. {{ document.copy_note }} Thanks.');
    expect(other.body).toBe('All done — we will mail you a copy.');
  });
});

describe('copyNoteFor', () => {
  it('gives the link and its expiry date when there is one', () => {
    const note = copyNoteFor({
      downloadUrl: 'https://portal.test/shared/file/abc.def',
      expiresAt: new Date('2026-09-25T12:00:00Z'),
    });
    expect(note).toContain('https://portal.test/shared/file/abc.def');
    expect(note).toContain('This link expires 2026-09-25.');
  });

  it('names the firm and both support channels when there is no link', () => {
    expect(
      copyNoteFor({
        supportEmail: 'help@firm.example',
        supportPhone: '555-0100',
        firmName: 'Kisaes CPA',
      }),
    ).toBe(
      'For a copy of the signed document, contact Kisaes CPA at help@firm.example or 555-0100.',
    );
  });

  it('falls back to replying when the firm published no support contact', () => {
    expect(copyNoteFor({ firmName: 'Kisaes CPA' })).toBe(
      'For a copy of the signed document, reply to this email and Kisaes CPA will send one.',
    );
  });
});
