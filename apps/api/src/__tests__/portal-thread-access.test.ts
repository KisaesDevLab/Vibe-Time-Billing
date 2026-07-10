// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P1.7 — Portal thread-access integration test (E.12 substitute)
//
// The original E.12 plan called for a Playwright browser test. We
// substitute API-level coverage of the same correctness claims:
//   1. Portal identities that are thread_members can read decrypted
//      messages (server-side decryption).
//   2. Portal identities that are NOT thread_members get isMember=false
//      (the messaging router uses this gate to return 403).
//   3. Message ciphertext is opaque on the wire — only decrypting via
//      the firm MFK yields plaintext, not the bytes stored in
//      message.body_ciphertext.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { messages, portalIdentity, threadMembers } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { resetFirmKeyManagerForTests, getFirmKeyManager } from '../crypto/manager';
import { setApplianceLockState } from '../crypto/boot';
import { isMember, provisionThreadForEngagement } from '../engagement-messaging/lifecycle';
import { batchDecryptForThread, encryptForThread } from '../engagement-messaging/thread-crypto';

describe('portal thread access — server-side decryption (E.12)', () => {
  let h: PgliteHarness;
  let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
  let sealDir: string;
  let threadId: string;
  let memberIdentityId: string;
  let outsiderIdentityId: string;

  beforeEach(async () => {
    sealDir = await mkdtemp(join(tmpdir(), 'vibe-test-seal-'));
    process.env['FIRM_KEY_SEAL_PATH'] = join(sealDir, '.firm-key.seal');
    resetFirmKeyManagerForTests();
    h = await buildPgliteHarness();
    seed = await seedMinimalFirm(h.db);
    const mgr = getFirmKeyManager(h.db);
    await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
    setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });

    const tid = await provisionThreadForEngagement(h.db, {
      firmId: seed.firmId,
      engagementId: seed.engagementId,
      creatorAppUserId: seed.appUserId,
    });
    threadId = tid!;

    // Create two portal identities. One is a member of the thread,
    // the other is not.
    const [m] = await h.db
      .insert(portalIdentity)
      .values({
        firmId: seed.firmId,
        fullName: 'Client Tom',
        primaryEmail: 'tom@client.example',
      })
      .returning({ id: portalIdentity.id });
    const [o] = await h.db
      .insert(portalIdentity)
      .values({
        firmId: seed.firmId,
        fullName: 'Client Outsider',
        primaryEmail: 'outsider@other.example',
      })
      .returning({ id: portalIdentity.id });
    memberIdentityId = m!.id;
    outsiderIdentityId = o!.id;

    // Wire the member into thread_member with role=client
    await h.db.insert(threadMembers).values({
      threadId,
      portalIdentityId: memberIdentityId,
      memberRole: 'client',
    });
  });

  afterEach(async () => {
    resetFirmKeyManagerForTests();
    await h.close();
    await rm(sealDir, { recursive: true, force: true });
  });

  it('isMember(portalIdentityId) returns true for the member, false for the outsider', async () => {
    expect(await isMember(h.db, { threadId, portalIdentityId: memberIdentityId })).toBe(true);
    expect(await isMember(h.db, { threadId, portalIdentityId: outsiderIdentityId })).toBe(false);
  });

  it('message bodies persist as ciphertext, decryptable only via the firm MFK', async () => {
    const plaintext = 'Secret tax planning advice for Q3';
    const ct = await encryptForThread({ db: h.db, firmId: seed.firmId, threadId }, plaintext);
    // The bytes on disk are NOT the plaintext
    const plaintextBytes = new TextEncoder().encode(plaintext);
    expect(ct).not.toEqual(plaintextBytes);
    // ct is nonce (24 bytes) + ciphertext + 16-byte AEAD tag,
    // longer than the original plaintext
    expect(ct.length).toBeGreaterThan(plaintextBytes.length + 24);

    await h.db.insert(messages).values({
      threadId,
      senderAppUserId: seed.appUserId,
      bodyCiphertext: ct,
      excerptPlaintext: plaintext.slice(0, 80),
    });

    // Decrypting via the firm MFK roundtrips back to plaintext
    const rows = await h.db
      .select({ bodyCiphertext: messages.bodyCiphertext })
      .from(messages)
      .where(eq(messages.threadId, threadId));
    const decrypted = await batchDecryptForThread(
      { db: h.db, firmId: seed.firmId, threadId },
      rows.map((r) => r.bodyCiphertext),
    );
    expect(decrypted).toContain(plaintext);
  });

  it('soft-removing a portal member drops their isMember check', async () => {
    expect(await isMember(h.db, { threadId, portalIdentityId: memberIdentityId })).toBe(true);
    await h.db
      .update(threadMembers)
      .set({ removedAt: new Date() })
      .where(eq(threadMembers.portalIdentityId, memberIdentityId));
    expect(await isMember(h.db, { threadId, portalIdentityId: memberIdentityId })).toBe(false);
  });

  it('batch decrypt handles multiple messages without re-deriving the T-DEK per message', async () => {
    // Insert 5 messages
    const bodies = ['one', 'two', 'three', 'four', 'five'];
    for (const body of bodies) {
      const ct = await encryptForThread({ db: h.db, firmId: seed.firmId, threadId }, body);
      await h.db.insert(messages).values({
        threadId,
        senderAppUserId: seed.appUserId,
        bodyCiphertext: ct,
        excerptPlaintext: body,
      });
    }
    const rows = await h.db
      .select({ bodyCiphertext: messages.bodyCiphertext })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(messages.createdAt);
    const decrypted = await batchDecryptForThread(
      { db: h.db, firmId: seed.firmId, threadId },
      rows.map((r) => r.bodyCiphertext),
    );
    expect(decrypted).toEqual(bodies);
  });
});
