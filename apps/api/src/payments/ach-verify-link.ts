// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0218 — ACH micro-deposit verification links. Mints and resolves the
// opaque token that lets a client confirm the micro-deposit amounts for
// a pending manual-ACH bank WITHOUT logging into the portal. Same trust
// model as pay-link-helper: ~128-bit token, sha256 at rest, expiry;
// multiple ACTIVE links may coexist for one method (each reminder mints
// its own — the plaintext is unrecoverable once stored).

import { createHash, randomBytes } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { achVerifyLinks } from '@vibe/db/schema';

export const ACH_VERIFY_LINK_TTL_DAYS = 30;

export type AchVerifyLinkRow = typeof achVerifyLinks.$inferSelect;

export function hashAchVerifyToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreateAchVerifyLinkInput {
  firmId: string;
  paymentMethodId: string;
  createdByAppUserId?: string | null;
  expiresAt?: Date | null;
  now?: Date;
}

/**
 * Mint a fresh link. Returns the PLAINTEXT token exactly once — the caller
 * delivers it and must never log it.
 */
export async function createAchVerifyLink(
  db: Database,
  input: CreateAchVerifyLinkInput,
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = randomBytes(16).toString('base64url');
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + ACH_VERIFY_LINK_TTL_DAYS * 86_400_000);

  const [row] = await db
    .insert(achVerifyLinks)
    .values({
      firmId: input.firmId,
      paymentMethodId: input.paymentMethodId,
      tokenHash: hashAchVerifyToken(token),
      status: 'ACTIVE',
      expiresAt,
      createdByAppUserId: input.createdByAppUserId ?? null,
      createdAt: now,
    })
    .returning({ id: achVerifyLinks.id });

  return { id: row!.id, token, expiresAt };
}

/** Resolve a token to its link row, or null on any mismatch (no info leak). */
export async function resolveAchVerifyLink(
  db: Database,
  token: string,
): Promise<AchVerifyLinkRow | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(achVerifyLinks)
    .where(eq(achVerifyLinks.tokenHash, hashAchVerifyToken(token)))
    .limit(1);
  return row ?? null;
}

export type AchVerifyLinkUsability =
  | { ok: true }
  | { ok: false; reason: 'verified' | 'voided' | 'expired' };

/** Whether a resolved link can still be used (status + expiry check). */
export function achVerifyLinkUsable(
  row: AchVerifyLinkRow,
  now: Date = new Date(),
): AchVerifyLinkUsability {
  if (row.status === 'VERIFIED') return { ok: false, reason: 'verified' };
  if (row.status === 'VOIDED') return { ok: false, reason: 'voided' };
  if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/** Bump the view counter (best-effort; failures are non-fatal to the caller). */
export async function markAchVerifyLinkAccessed(db: Database, id: string): Promise<void> {
  await db
    .update(achVerifyLinks)
    .set({ accessCount: sql`${achVerifyLinks.accessCount} + 1`, lastAccessedAt: new Date() })
    .where(eq(achVerifyLinks.id, id));
}

/** Flip every ACTIVE link for a method to a terminal status. */
export async function closeAchVerifyLinks(
  db: Database,
  paymentMethodId: string,
  status: 'VERIFIED' | 'VOIDED',
): Promise<void> {
  await db
    .update(achVerifyLinks)
    .set({ status, ...(status === 'VERIFIED' ? { verifiedAt: new Date() } : {}) })
    .where(
      and(eq(achVerifyLinks.paymentMethodId, paymentMethodId), eq(achVerifyLinks.status, 'ACTIVE')),
    );
}
