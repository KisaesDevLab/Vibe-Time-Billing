// SPDX-License-Identifier: Elastic-2.0
//
// 0181 — pay-by-link helper. Mints and resolves the opaque token that
// lets a client pay an invoice without logging into the portal. The
// token is ~128 bits (16 random bytes, base64url) so it is short enough
// to drop into an SMS yet infeasible to guess; only its sha256 is stored
// (never the plaintext, never logged). Re-issuing for an invoice voids
// any prior ACTIVE link so a single live link exists per invoice.

import { createHash, randomBytes } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { invoicePayLinks } from '@vibe/db/schema';

export const PAY_LINK_DEFAULT_TTL_DAYS = 30;

export type PayLinkRow = typeof invoicePayLinks.$inferSelect;

export function hashPayLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatePayLinkInput {
  firmId: string;
  invoiceId: string;
  createdByAppUserId?: string | null;
  /** Requested expiry; defaults to PAY_LINK_DEFAULT_TTL_DAYS out. */
  expiresAt?: Date | null;
  now?: Date;
}

export interface CreatePayLinkResult {
  id: string;
  token: string;
  expiresAt: Date;
}

/**
 * Mint a fresh link. Returns the PLAINTEXT token exactly once — the caller
 * delivers it and must never log it. Multiple ACTIVE links may coexist for
 * one invoice (a link sent by SMS and another by email both stay valid); a
 * link dies only when the invoice is paid through it, it expires, or it is
 * explicitly revoked. The plaintext token is unrecoverable once stored, so
 * each delivery necessarily mints its own — we never invalidate a link a
 * client may already be holding.
 */
export async function createPayLink(
  db: Database,
  input: CreatePayLinkInput,
): Promise<CreatePayLinkResult> {
  const now = input.now ?? new Date();

  const token = randomBytes(16).toString('base64url');
  const tokenHash = hashPayLinkToken(token);
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + PAY_LINK_DEFAULT_TTL_DAYS * 86_400_000);

  const [row] = await db
    .insert(invoicePayLinks)
    .values({
      firmId: input.firmId,
      invoiceId: input.invoiceId,
      tokenHash,
      status: 'ACTIVE',
      expiresAt,
      createdByAppUserId: input.createdByAppUserId ?? null,
      createdAt: now,
    })
    .returning({ id: invoicePayLinks.id });

  return { id: row!.id, token, expiresAt };
}

/** Flip every ACTIVE link for an invoice to VOIDED (re-issue / cancel). */
export async function voidActivePayLinks(db: Database, invoiceId: string): Promise<void> {
  await db
    .update(invoicePayLinks)
    .set({ status: 'VOIDED' })
    .where(and(eq(invoicePayLinks.invoiceId, invoiceId), eq(invoicePayLinks.status, 'ACTIVE')));
}

/**
 * Resolve a token to its link row, or null on any mismatch (no info leak).
 * Does NOT check status/expiry — callers decide how to surface those so the
 * landing page can show friendly "expired"/"paid" states for a valid token.
 */
export async function resolvePayLink(db: Database, token: string): Promise<PayLinkRow | null> {
  if (!token) return null;
  const tokenHash = hashPayLinkToken(token);
  const [row] = await db
    .select()
    .from(invoicePayLinks)
    .where(eq(invoicePayLinks.tokenHash, tokenHash))
    .limit(1);
  return row ?? null;
}

export type PayLinkUsability = { ok: true } | { ok: false; reason: 'voided' | 'paid' | 'expired' };

/** Whether a resolved link can still be paid (status + expiry check). */
export function payLinkUsable(row: PayLinkRow, now: Date = new Date()): PayLinkUsability {
  if (row.status === 'PAID') return { ok: false, reason: 'paid' };
  if (row.status === 'VOIDED') return { ok: false, reason: 'voided' };
  if (row.expiresAt && row.expiresAt.getTime() < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/** Bump the view counter (best-effort; failures are non-fatal to the caller). */
export async function markPayLinkAccessed(db: Database, id: string): Promise<void> {
  await db
    .update(invoicePayLinks)
    .set({ accessCount: sql`${invoicePayLinks.accessCount} + 1`, lastAccessedAt: new Date() })
    .where(eq(invoicePayLinks.id, id));
}
