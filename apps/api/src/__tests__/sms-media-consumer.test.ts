// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0234 — MMS pipeline: fetch (no credentials on the S3 redirect), sha256,
// object storage under system/sms-media/…, Intake session hand-off when
// the feature is on, delete from Twilio, and the delete-failure path that
// keeps remote_deleted=false for the retry sweep.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq, sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  intakeFiles,
  intakeSessions,
  smsConversations,
  smsMedia,
  smsMessages,
} from '@vibe/db/schema';
import { MockStorageClient } from '@vibe/storage';

import {
  buildPgliteHarness,
  seedMinimalFirm,
  seedSmsLine,
  type PgliteHarness,
} from './_pglite-harness';
import { setApplianceLockState } from '../crypto/boot';
import { getFirmKeyManager, resetFirmKeyManagerForTests } from '../crypto/manager';
import { processSmsMediaJob } from '../sms/media-consumer';
import type { TwilioClient } from '../sms/twilio-client';

const log = pino({ enabled: false });
const AC = 'AC' + 'a'.repeat(32);
const MSG_SID = 'MM' + '1'.repeat(32);
const MEDIA_SID = 'ME' + 'a'.repeat(32);

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;
let storage: MockStorageClient;
let tmpDir: string;
let mediaId: string;
let deleted: string[];
let deleteShouldFail = false;

function fakeTwilio(): TwilioClient {
  return {
    async fetchMedia(url: string) {
      expect(url).toContain('api.twilio.com');
      return { bytes: Buffer.from('JPEGDATA'), contentType: 'image/jpeg' };
    },
    async deleteMedia(msgSid: string, mSid: string) {
      if (deleteShouldFail) throw new Error('twilio 500');
      deleted.push(`${msgSid}/${mSid}`);
    },
  } as unknown as TwilioClient;
}

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
  tmpDir = mkdtempSync(join(tmpdir(), 'sms-media-'));
  storage = new MockStorageClient({ rootPath: tmpDir });
  deleted = [];
  deleteShouldFail = false;
  await harness.db.execute(sql`INSERT INTO firm_settings (firm_id) VALUES (${seed.firmId})`);
  await harness.db.execute(
    sql`INSERT INTO firm_config (firm_id, intake_enabled) VALUES (${seed.firmId}, true)`,
  );
  const { lineId } = await seedSmsLine(harness.db, { firmId: seed.firmId });
  const [conv] = await harness.db
    .insert(smsConversations)
    .values({
      firmId: seed.firmId,
      lineId,
      externalNumberE164: '+13125550148',
      clientId: seed.clientId,
    })
    .returning({ id: smsConversations.id });
  const [msg] = await harness.db
    .insert(smsMessages)
    .values({
      firmId: seed.firmId,
      conversationId: conv!.id,
      direction: 'inbound',
      fromE164: '+13125550148',
      toE164: '+12025550100',
      body: 'here is my W-2',
      providerMessageId: MSG_SID,
      providerStatus: 'received',
      contextKind: 'inbound',
      numMedia: 1,
    })
    .returning({ id: smsMessages.id });
  const [m] = await harness.db
    .insert(smsMedia)
    .values({
      firmId: seed.firmId,
      messageId: msg!.id,
      providerMediaSid: MEDIA_SID,
      providerMediaUrl: `https://api.twilio.com/2010-04-01/Accounts/${AC}/Messages/${MSG_SID}/Media/${MEDIA_SID}`,
      contentType: 'image/jpeg',
    })
    .returning({ id: smsMedia.id });
  mediaId = m!.id;
});

afterEach(async () => {
  resetFirmKeyManagerForTests();
  await harness.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Bootstrap a sealed-on-disk firm key so intake's per-record DEK wrap works
// (mirrors intake-crypto.test.ts).
async function unlock(): Promise<void> {
  process.env['FIRM_KEY_SEAL_PATH'] = join(tmpDir, '.firm-key.seal');
  resetFirmKeyManagerForTests();
  const mgr = getFirmKeyManager(harness.db);
  await mgr.bootstrap({ firmId: seed.firmId, mode: 'sealed-on-disk' });
  setApplianceLockState({ kind: 'unlocked', firmId: seed.firmId });
}

describe('sms media consumer', () => {
  it('stores the media and marks it stored when intake is off', async () => {
    await harness.db.execute(sql`UPDATE firm_config SET intake_enabled = false`);
    const outcome = await processSmsMediaJob(
      {
        db: harness.db,
        log,
        storage,
        twilioClient: async () => fakeTwilio(),
        enqueueIntake: false,
      },
      { mediaId, firmId: seed.firmId },
    );
    expect(outcome).toBe('stored');
    const [m] = await harness.db.select().from(smsMedia).where(eq(smsMedia.id, mediaId));
    expect(m!.status).toBe('stored');
    expect(m!.storageKey).toMatch(/^system\/sms-media\/.+\.jpg$/);
    expect(m!.sha256).toHaveLength(64);
    expect(m!.sizeBytes).toBe(8);
    expect(m!.remoteDeleted).toBe(true);
    expect(deleted).toEqual([`${MSG_SID}/${MEDIA_SID}`]);
    expect(await storage.head(m!.storageKey!)).not.toBeNull();
  });

  it('defers the Intake hand-off while the appliance is locked (object kept, retry scheduled)', async () => {
    await expect(
      processSmsMediaJob(
        {
          db: harness.db,
          log,
          storage,
          twilioClient: async () => fakeTwilio(),
          enqueueIntake: false,
        },
        { mediaId, firmId: seed.firmId },
      ),
    ).rejects.toThrow(/intake_crypto_locked/);
    const [m] = await harness.db.select().from(smsMedia).where(eq(smsMedia.id, mediaId));
    expect(m!.status).toBe('stored');
    expect(m!.storageKey).toBeTruthy();
    expect(m!.attemptCount).toBe(1);
    expect(await harness.db.select().from(intakeSessions)).toHaveLength(0);
  });

  it('hands the file to Document Intake when enabled', async () => {
    await unlock();
    const outcome = await processSmsMediaJob(
      {
        db: harness.db,
        log,
        storage,
        twilioClient: async () => fakeTwilio(),
        enqueueIntake: false,
      },
      { mediaId, firmId: seed.firmId },
    );
    expect(outcome).toBe('intake');
    const [m] = await harness.db.select().from(smsMedia).where(eq(smsMedia.id, mediaId));
    expect(m!.status).toBe('intake');
    expect(m!.intakeSessionId).toBeTruthy();
    const [session] = await harness.db.select().from(intakeSessions);
    expect(session!.source).toBe('sms');
    expect(session!.matchedClientId).toBe(seed.clientId);
    expect(session!.targetStaffId).toBe(seed.appUserId);
    const files = await harness.db.select().from(intakeFiles);
    expect(files).toHaveLength(1);
    expect(files[0]!.objectKey).toMatch(/^intake\/quarantine\//);
    expect(m!.remoteDeleted).toBe(true);
  });

  it('keeps remote_deleted=false when the Twilio delete fails (retry sweep picks it up)', async () => {
    await harness.db.execute(sql`UPDATE firm_config SET intake_enabled = false`);
    deleteShouldFail = true;
    const outcome = await processSmsMediaJob(
      {
        db: harness.db,
        log,
        storage,
        twilioClient: async () => fakeTwilio(),
        enqueueIntake: false,
      },
      { mediaId, firmId: seed.firmId },
    );
    expect(outcome).toBe('stored');
    const [m] = await harness.db.select().from(smsMedia).where(eq(smsMedia.id, mediaId));
    expect(m!.status).toBe('stored');
    expect(m!.remoteDeleted).toBe(false);
  });

  it('counts attempts and fails after the cap', async () => {
    const boom = {
      ...fakeTwilio(),
      fetchMedia: async () => {
        throw new Error('media 404');
      },
    } as TwilioClient;
    await harness.db.update(smsMedia).set({ attemptCount: 4 }).where(eq(smsMedia.id, mediaId));
    const outcome = await processSmsMediaJob(
      { db: harness.db, log, storage, twilioClient: async () => boom, enqueueIntake: false },
      { mediaId, firmId: seed.firmId },
    );
    expect(outcome).toBe('failed');
    const [m] = await harness.db.select().from(smsMedia).where(eq(smsMedia.id, mediaId));
    expect(m!.status).toBe('failed');
    expect(m!.error).toContain('media 404');
  });
});
