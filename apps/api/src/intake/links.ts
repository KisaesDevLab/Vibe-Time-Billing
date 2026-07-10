// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Send a link" — a staff member generates a one-time, expiring intake link
// pre-bound to a target staff member. The token is the bearer credential;
// only its SHA-256 hash is stored (CLAUDE.md token-at-rest rule). The
// recipient's contact (the firm's record of who it was sent to) is
// MFK-encrypted per-record like a session.

import { createHash, randomBytes } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { intakeLinks } from '@vibe/db/schema';

import { newIntakeRecordKey, encField } from './crypto';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateLinkArgs {
  firmId: string;
  createdByUserId: string;
  targetStaffId: string;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  expiresInDays?: number;
}

/** Create a link; returns the plaintext token (shown once) + the row id. */
export function createIntakeLink(
  db: Database,
  args: CreateLinkArgs,
): Promise<{ token: string; linkId: string }> {
  const token = randomBytes(24).toString('base64url');
  const { dek, wrappedDek } = newIntakeRecordKey(db, args.firmId);
  const expiresAt =
    args.expiresInDays && args.expiresInDays > 0
      ? new Date(Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
  return db
    .insert(intakeLinks)
    .values({
      firmId: args.firmId,
      createdByUserId: args.createdByUserId,
      targetStaffId: args.targetStaffId,
      tokenHash: hashToken(token),
      expiresAt,
      wrappedDek: Buffer.from(wrappedDek),
      recipientEmailEnc: encField(dek, args.recipientEmail ?? null),
      recipientPhoneEnc: encField(dek, args.recipientPhone ?? null),
    })
    .returning({ id: intakeLinks.id })
    .then((rows) => ({ token, linkId: rows[0]!.id }));
}

export interface ResolvedLink {
  linkId: string;
  targetStaffId: string;
}

/** Validate a token (active, unexpired, unrevoked, unused) for a firm. */
export async function resolveIntakeLink(
  db: Database,
  firmId: string,
  token: string,
): Promise<ResolvedLink | null> {
  if (!token || token.length < 10) return null;
  const [row] = await db
    .select({
      id: intakeLinks.id,
      targetStaffId: intakeLinks.targetStaffId,
      expiresAt: intakeLinks.expiresAt,
      usedAt: intakeLinks.usedAt,
    })
    .from(intakeLinks)
    .where(
      and(
        eq(intakeLinks.firmId, firmId),
        eq(intakeLinks.tokenHash, hashToken(token)),
        isNull(intakeLinks.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  return { linkId: row.id, targetStaffId: row.targetStaffId };
}

/** Stamp a link used once a session is created from it. */
export async function markLinkUsed(db: Database, linkId: string): Promise<void> {
  await db
    .update(intakeLinks)
    .set({ usedAt: new Date() })
    .where(and(eq(intakeLinks.id, linkId), isNull(intakeLinks.usedAt)));
}
