// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Drizzle-backed FirmKeyStore for @vibe/crypto's FirmKeyManager.
// Lives in the API layer so the crypto package stays DB-agnostic.

import { eq } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { firmKeyEnvelope } from '@vibe/db/schema';
import type { FirmKeyEnvelopeRow, FirmKeyStore, KekMetadata } from '@vibe/crypto';

export function createFirmKeyStore(db: Database): FirmKeyStore {
  return {
    async get(firmId: string): Promise<FirmKeyEnvelopeRow | null> {
      const [row] = await db
        .select()
        .from(firmKeyEnvelope)
        .where(eq(firmKeyEnvelope.firmId, firmId))
        .limit(1);
      if (!row) return null;
      return {
        firmId: row.firmId,
        wrappedMfk: row.wrappedMfk,
        kekMetadata: row.kekMetadata as KekMetadata,
        sentinelCiphertext: row.sentinelCiphertext,
        rotationVersion: row.rotationVersion,
      };
    },
    async insert(row: FirmKeyEnvelopeRow): Promise<void> {
      await db.insert(firmKeyEnvelope).values({
        firmId: row.firmId,
        wrappedMfk: row.wrappedMfk,
        kekMetadata: row.kekMetadata,
        sentinelCiphertext: row.sentinelCiphertext,
        rotationVersion: row.rotationVersion,
      });
    },
    async update(row: FirmKeyEnvelopeRow): Promise<void> {
      await db
        .update(firmKeyEnvelope)
        .set({
          wrappedMfk: row.wrappedMfk,
          kekMetadata: row.kekMetadata,
          sentinelCiphertext: row.sentinelCiphertext,
          rotationVersion: row.rotationVersion,
          updatedAt: new Date(),
        })
        .where(eq(firmKeyEnvelope.firmId, row.firmId));
    },
  };
}
