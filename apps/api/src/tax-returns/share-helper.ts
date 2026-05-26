// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// TR-6 — Client → 3rd-party share helper.
//
// Issues an Argon2id-hashed share token (32 random bytes base64url),
// validates the requested section subset against the caller's
// release scope, and enforces rate limits per the plan §8.1.
//
// Rate limits enforced server-side:
//   • Per shared_by_access_id: ≤ 50 created per 24h
//   • Per shared_by_access_id × return_id: ≤ 10 ACTIVE (SENT|VIEWED)
//   • Per recipient_email globally: ≤ 5 ACTIVE
//   • expires_at capped at sent_at + 90 days regardless of request

import { randomBytes } from 'node:crypto';

import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { taxReturnReleases, taxReturnSections, taxReturnShares } from '@vibe/db/schema';
import { hashPassword } from '@vibe/crypto';

const MAX_PER_ACCESS_PER_24H = 50;
const MAX_ACTIVE_PER_RETURN = 10;
const MAX_ACTIVE_PER_RECIPIENT_EMAIL = 5;
const MAX_EXPIRY_DAYS = 90;

export class ShareError extends Error {
  constructor(
    public code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ShareError';
  }
}

export interface CreateShareInput {
  db: Database;
  returnId: string;
  // The client_access making the share. Must own a release of the
  // return.
  sharedByAccessId: string;
  // The clientIds this access can read (driven by client_portal_access).
  callerClientIds: string[];
  recipientName: string;
  recipientEmail: string;
  recipientPhone: string | null;
  organization: string;
  role: string;
  accessLevel: 'view_only' | 'view_download';
  scope: 'FULL' | 'SELECTED';
  sectionIds: string[];
  // Caller-requested expiry. Capped at +90d.
  expiresAt: Date;
  require2fa: boolean;
  verifyChannel: 'SMS' | 'EMAIL' | 'NONE';
  watermark: boolean;
  personalMessage: string;
}

export interface CreateShareResult {
  shareId: string;
  // Plaintext token — caller embeds in the outbound email/SMS body.
  // Never logged, never returned in any other API.
  token: string;
  expiresAt: Date;
}

export async function createShare(input: CreateShareInput): Promise<CreateShareResult> {
  // ---- 1. Find the live release for this (return, caller) ----
  if (input.callerClientIds.length === 0) {
    throw new ShareError('forbidden', 'caller has no client access');
  }
  const [release] = await input.db
    .select({
      id: taxReturnReleases.id,
      scope: taxReturnReleases.scope,
      sectionIds: taxReturnReleases.sectionIds,
      revokedAt: taxReturnReleases.revokedAt,
    })
    .from(taxReturnReleases)
    .where(
      and(
        eq(taxReturnReleases.returnId, input.returnId),
        inArray(taxReturnReleases.releasedToClientId, input.callerClientIds),
      ),
    )
    .limit(1);
  if (!release || release.revokedAt) {
    throw new ShareError('release_not_found', 'no live release for this return');
  }

  // ---- 2. Validate section_ids against the RELEASE scope ----
  if (input.scope === 'FULL' && input.sectionIds.length > 0) {
    throw new ShareError('scope_mismatch', 'FULL scope must have empty sectionIds');
  }
  if (input.scope === 'SELECTED' && input.sectionIds.length === 0) {
    throw new ShareError('scope_mismatch', 'SELECTED scope requires at least one section_id');
  }
  if (input.scope === 'SELECTED') {
    // Each section must be in the release's section_ids set (or, when
    // the release is FULL, in the return's section catalog).
    let allowedIds: Set<string>;
    if (release.scope === 'FULL') {
      const sections = await input.db
        .select({ id: taxReturnSections.id })
        .from(taxReturnSections)
        .where(eq(taxReturnSections.returnId, input.returnId));
      allowedIds = new Set(sections.map((s) => s.id));
    } else {
      allowedIds = new Set(release.sectionIds);
    }
    for (const id of input.sectionIds) {
      if (!allowedIds.has(id)) {
        throw new ShareError(
          'section_outside_release',
          `section ${id} is not in your release scope`,
        );
      }
    }
  }

  // ---- 3. Rate limits ----
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [recent] = await input.db
    .select({ n: count() })
    .from(taxReturnShares)
    .where(
      and(
        eq(taxReturnShares.sharedByAccessId, input.sharedByAccessId),
        gt(taxReturnShares.sentAt, dayAgo),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_PER_ACCESS_PER_24H) {
    throw new ShareError('rate_limit_24h', `max ${MAX_PER_ACCESS_PER_24H} shares per 24h reached`);
  }

  const [activeOnReturn] = await input.db
    .select({ n: count() })
    .from(taxReturnShares)
    .where(
      and(
        eq(taxReturnShares.sharedByAccessId, input.sharedByAccessId),
        eq(taxReturnShares.returnId, input.returnId),
        inArray(taxReturnShares.status, ['SENT', 'VIEWED']),
      ),
    );
  if ((activeOnReturn?.n ?? 0) >= MAX_ACTIVE_PER_RETURN) {
    throw new ShareError(
      'rate_limit_active_per_return',
      `max ${MAX_ACTIVE_PER_RETURN} active shares per return`,
    );
  }

  const [activeForEmail] = await input.db
    .select({ n: count() })
    .from(taxReturnShares)
    .where(
      and(
        eq(taxReturnShares.recipientEmail, input.recipientEmail.toLowerCase()),
        inArray(taxReturnShares.status, ['SENT', 'VIEWED']),
      ),
    );
  if ((activeForEmail?.n ?? 0) >= MAX_ACTIVE_PER_RECIPIENT_EMAIL) {
    throw new ShareError(
      'rate_limit_recipient_email',
      `max ${MAX_ACTIVE_PER_RECIPIENT_EMAIL} active shares per recipient email`,
    );
  }

  // ---- 4. Cap expiry at 90d ----
  const cap = new Date(now.getTime() + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const expiresAt = input.expiresAt.getTime() > cap.getTime() ? cap : input.expiresAt;
  if (expiresAt.getTime() <= now.getTime()) {
    throw new ShareError('expiry_in_past', 'expires_at must be in the future');
  }

  // ---- 5. Mint token + hash ----
  const token = randomBytes(32).toString('base64url');
  const tokenHash = await hashPassword(token);

  // ---- 6. Insert ----
  const [created] = await input.db
    .insert(taxReturnShares)
    .values({
      returnId: input.returnId,
      releaseId: release.id,
      sharedByAccessId: input.sharedByAccessId,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail.toLowerCase(),
      recipientPhone: input.recipientPhone,
      organization: input.organization,
      role: input.role,
      accessLevel: input.accessLevel,
      scope: input.scope,
      sectionIds: input.sectionIds,
      expiresAt,
      require2fa: input.require2fa,
      verifyChannel: input.verifyChannel,
      watermark: input.watermark,
      tokenHash,
      personalMessage: input.personalMessage,
      status: 'SENT',
      sentAt: now,
    })
    .returning({ id: taxReturnShares.id });

  if (!created) throw new ShareError('insert_failed', 'share not created');
  return { shareId: created.id, token, expiresAt };
}

export async function revokeShare(
  db: Database,
  shareId: string,
  revokedByAccessId: string,
  callerClientIds: string[],
): Promise<void> {
  const [row] = await db
    .select({
      id: taxReturnShares.id,
      revokedAt: taxReturnShares.revokedAt,
      releaseClientId: taxReturnReleases.releasedToClientId,
    })
    .from(taxReturnShares)
    .innerJoin(taxReturnReleases, eq(taxReturnReleases.id, taxReturnShares.releaseId))
    .where(eq(taxReturnShares.id, shareId))
    .limit(1);
  if (!row) throw new ShareError('share_not_found', shareId);
  if (!callerClientIds.includes(row.releaseClientId)) {
    throw new ShareError('forbidden', 'share belongs to another client');
  }
  if (row.revokedAt) return;
  await db
    .update(taxReturnShares)
    .set({
      status: 'REVOKED',
      revokedAt: new Date(),
      revokedByAccessId,
    })
    .where(eq(taxReturnShares.id, shareId));
}

// Cron-friendly: mark any share whose expires_at has passed as
// EXPIRED. Returns the count flipped for caller logging.
export async function markExpiredShares(db: Database): Promise<number> {
  const result = await db.execute(
    sql`UPDATE tax_return_shares
        SET status = 'EXPIRED'
        WHERE status IN ('SENT', 'VIEWED')
          AND expires_at < NOW()`,
  );
  const r = result as unknown as { rowCount?: number; affectedRows?: number };
  return r.rowCount ?? r.affectedRows ?? 0;
}
