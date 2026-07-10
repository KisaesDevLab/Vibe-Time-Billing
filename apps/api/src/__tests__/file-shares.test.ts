// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// CP11 — File share lifecycle tests.
//
// Pinned invariants:
//   1. token_hash UNIQUE — accidentally generating the same hash
//      (collision) fails the INSERT.
//   2. access_level CHECK — only 'view' / 'download' allowed.
//   3. Expiry filter SQL — the portal-list view excludes expired
//      and revoked rows.
//   4. /shared/:token public lookup hashes the input + matches.
//   5. file_share_event outcome CHECK rejects unknown values.

import { createHash } from 'node:crypto';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';

let harness: PgliteHarness;

beforeEach(async () => {
  harness = await buildPgliteHarness();
});

afterEach(async () => {
  await harness.close();
});

async function setupFile(): Promise<{
  firmId: string;
  clientId: string;
  fileId: string;
  identityId: string;
}> {
  const seed = await seedMinimalFirm(harness.db);
  // client_folders for FK on files.client_folder_id
  const folder = await harness.db.execute(
    sql`INSERT INTO client_folders (firm_id, client_id, status, storage_path)
        VALUES (${seed.firmId}, ${seed.clientId}, 'active', 'firm-x/client-y')
        RETURNING id`,
  );
  const folderId = (folder as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const fileRow = await harness.db.execute(
    sql`INSERT INTO files (firm_id, client_id, client_folder_id, subfolder_path,
                            original_filename, mime_type, size_bytes, storage_key,
                            visibility)
        VALUES (${seed.firmId}, ${seed.clientId}, ${folderId}, '',
                'tax-return.pdf', 'application/pdf', 102400, 'firm/x/y/z.pdf',
                'client_visible')
        RETURNING id`,
  );
  const fileId = (fileRow as unknown as { rows: { id: string }[] }).rows[0]!.id;
  const idRes = await harness.db.execute(
    sql`INSERT INTO portal_identity (firm_id, full_name, primary_email)
        VALUES (${seed.firmId}, 'Sharer', 'sharer@test.example') RETURNING id`,
  );
  const identityId = (idRes as unknown as { rows: { id: string }[] }).rows[0]!.id;
  return { firmId: seed.firmId, clientId: seed.clientId, fileId, identityId };
}

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

describe('file_share schema', () => {
  it('insert + lookup by token_hash works', async () => {
    const f = await setupFile();
    const rawToken = 'a'.repeat(64);
    const tokenHash = hashToken(rawToken);
    await harness.db.execute(
      sql`INSERT INTO file_share (firm_id, client_id, file_id,
                                   created_by_portal_identity_id, token_hash, access_level)
          VALUES (${f.firmId}, ${f.clientId}, ${f.fileId},
                  ${f.identityId}, ${tokenHash}, 'view')`,
    );
    const lookup = await harness.db.execute(
      sql`SELECT id, access_level FROM file_share WHERE token_hash = ${tokenHash}`,
    );
    const rows = (lookup as unknown as { rows: { id: string; access_level: string }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.access_level).toBe('view');
  });

  it('token_hash UNIQUE — duplicate insert rejected', async () => {
    const f = await setupFile();
    const tokenHash = hashToken('same-token');
    await harness.db.execute(
      sql`INSERT INTO file_share (firm_id, client_id, file_id, token_hash, access_level)
          VALUES (${f.firmId}, ${f.clientId}, ${f.fileId}, ${tokenHash}, 'view')`,
    );
    await expect(
      harness.db.execute(
        sql`INSERT INTO file_share (firm_id, client_id, file_id, token_hash, access_level)
            VALUES (${f.firmId}, ${f.clientId}, ${f.fileId}, ${tokenHash}, 'view')`,
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('access_level CHECK rejects unknown values', async () => {
    const f = await setupFile();
    await expect(
      harness.db.execute(
        sql`INSERT INTO file_share (firm_id, client_id, file_id, token_hash, access_level)
            VALUES (${f.firmId}, ${f.clientId}, ${f.fileId}, 'x', 'admin')`,
      ),
    ).rejects.toThrow(/file_share_access_level_ck|check/i);
  });

  it('access_count CHECK rejects negative values', async () => {
    const f = await setupFile();
    await harness.db.execute(
      sql`INSERT INTO file_share (firm_id, client_id, file_id, token_hash, access_level)
          VALUES (${f.firmId}, ${f.clientId}, ${f.fileId}, 'x', 'view')`,
    );
    await expect(
      harness.db.execute(sql`UPDATE file_share SET access_count = -1 WHERE token_hash = 'x'`),
    ).rejects.toThrow(/access_count_nonneg|check/i);
  });
});

describe('file_share_event schema', () => {
  it('outcome CHECK rejects unknown values', async () => {
    const f = await setupFile();
    const tokenHash = hashToken('evt');
    const ins = await harness.db.execute(
      sql`INSERT INTO file_share (firm_id, client_id, file_id, token_hash, access_level)
          VALUES (${f.firmId}, ${f.clientId}, ${f.fileId}, ${tokenHash}, 'view')
          RETURNING id`,
    );
    const shareId = (ins as unknown as { rows: { id: string }[] }).rows[0]!.id;
    await expect(
      harness.db.execute(
        sql`INSERT INTO file_share_event (file_share_id, outcome, ip)
            VALUES (${shareId}, 'totally-fine-honest', '1.2.3.4')`,
      ),
    ).rejects.toThrow(/file_share_event_outcome_ck|check/i);
  });

  it('allowed events increment access_count via the public route logic', async () => {
    const f = await setupFile();
    const tokenHash = hashToken('inc');
    const ins = await harness.db.execute(
      sql`INSERT INTO file_share (firm_id, client_id, file_id, token_hash, access_level)
          VALUES (${f.firmId}, ${f.clientId}, ${f.fileId}, ${tokenHash}, 'view')
          RETURNING id`,
    );
    const shareId = (ins as unknown as { rows: { id: string }[] }).rows[0]!.id;
    // Simulate two allowed accesses via the same SQL the public route runs.
    for (let i = 0; i < 2; i++) {
      await harness.db.execute(
        sql`INSERT INTO file_share_event (file_share_id, outcome, ip)
            VALUES (${shareId}, 'allowed', '1.2.3.4')`,
      );
      await harness.db.execute(
        sql`UPDATE file_share SET access_count = access_count + 1, last_accessed_at = now()
            WHERE id = ${shareId}`,
      );
    }
    const row = await harness.db.execute(
      sql`SELECT access_count, last_accessed_at FROM file_share WHERE id = ${shareId}`,
    );
    const r = (row as unknown as { rows: { access_count: number; last_accessed_at: string }[] })
      .rows[0]!;
    expect(r.access_count).toBe(2);
    expect(r.last_accessed_at).not.toBeNull();
  });
});

describe('share visibility filter (portal list)', () => {
  it('excludes revoked + expired rows', async () => {
    const f = await setupFile();
    const active = hashToken('active');
    const expired = hashToken('expired');
    const revoked = hashToken('revoked');
    await harness.db.execute(
      sql`INSERT INTO file_share (firm_id, client_id, file_id, token_hash, access_level, expires_at)
          VALUES (${f.firmId}, ${f.clientId}, ${f.fileId}, ${active}, 'view', now() + INTERVAL '7 days'),
                 (${f.firmId}, ${f.clientId}, ${f.fileId}, ${expired}, 'view', now() - INTERVAL '1 day'),
                 (${f.firmId}, ${f.clientId}, ${f.fileId}, ${revoked}, 'view', NULL)`,
    );
    await harness.db.execute(
      sql`UPDATE file_share SET revoked_at = now() WHERE token_hash = ${revoked}`,
    );
    // Mirror the portal-list SQL.
    const list = await harness.db.execute(
      sql`SELECT token_hash FROM file_share
          WHERE file_id = ${f.fileId}
            AND client_id = ${f.clientId}
            AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now())`,
    );
    const hashes = (list as unknown as { rows: { token_hash: string }[] }).rows.map(
      (r) => r.token_hash,
    );
    expect(hashes).toContain(active);
    expect(hashes).not.toContain(expired);
    expect(hashes).not.toContain(revoked);
  });
});
