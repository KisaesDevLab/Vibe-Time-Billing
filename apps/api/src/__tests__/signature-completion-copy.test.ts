// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The completion confirmation used to tell the client "a copy is available
// for your records" without saying how to get one. It now either encloses
// the signed PDF or names who to contact — and the sentence it renders is
// always consistent with what the email actually carries.

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
import {
  copyNoteFor,
  notifySignatureCompleted,
  MAX_ATTACHED_COPY_BYTES,
} from '../signatures/completion-notify';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

interface Sent {
  to: string;
  subject: string;
  body: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
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
  it('attaches the signed PDF and says so', async () => {
    const sent: Sent[] = [];
    await notifySignatureCompleted(
      harness.db,
      requestInfo(),
      ['signer@example.com'],
      async (a) => {
        sent.push(a);
      },
      Buffer.from('%PDF signed'),
    );

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe('dana@example.com');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments![0]!.filename).toBe('Engagement Letter (signed).pdf');
    expect(mail.attachments![0]!.contentType).toBe('application/pdf');
    expect(mail.body).toContain('Your signed copy is attached to this email.');
    // The old copy promised a copy and left the client with no next step.
    expect(mail.body).not.toContain('A copy is available for your records.');
  });

  it('tells the client who to contact when there is no PDF to attach', async () => {
    const sent: Sent[] = [];
    await notifySignatureCompleted(
      harness.db,
      requestInfo(),
      ['signer@example.com'],
      async (a) => {
        sent.push(a);
      },
      null,
    );

    expect(sent[0]!.attachments).toBeUndefined();
    expect(sent[0]!.body).toContain('For a copy of the signed document');
    expect(sent[0]!.body).not.toContain('attached to this email');
  });

  it('does not attach a PDF over the size cap, and adjusts the wording', async () => {
    const sent: Sent[] = [];
    await notifySignatureCompleted(
      harness.db,
      requestInfo(),
      ['signer@example.com'],
      async (a) => {
        sent.push(a);
      },
      Buffer.alloc(MAX_ATTACHED_COPY_BYTES + 1),
    );

    expect(sent[0]!.attachments).toBeUndefined();
    expect(sent[0]!.body).toContain('For a copy of the signed document');
  });

  it('renders the firm template through {{ document.copy_note }}', async () => {
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
      Buffer.from('%PDF signed'),
    );

    expect(sent[0]!.subject).toBe('All signed');
    expect(sent[0]!.body).toBe('Done. Your signed copy is attached to this email.');
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
  it('names the firm and both support channels when nothing is attached', () => {
    expect(
      copyNoteFor({
        attached: false,
        supportEmail: 'help@firm.example',
        supportPhone: '555-0100',
        firmName: 'Kisaes CPA',
      }),
    ).toBe(
      'For a copy of the signed document, contact Kisaes CPA at help@firm.example or 555-0100.',
    );
  });

  it('falls back to replying when the firm published no support contact', () => {
    expect(copyNoteFor({ attached: false, firmName: 'Kisaes CPA' })).toBe(
      'For a copy of the signed document, reply to this email and Kisaes CPA will send one.',
    );
  });
});
