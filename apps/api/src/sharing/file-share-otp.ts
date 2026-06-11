// SPDX-License-Identifier: Elastic-2.0
//
// 0150 — OTP challenges + browser grants for gated file shares.
//
// One file_share_otp row per "send access code". The 6-digit code and
// the post-verify browser grant are sha256-hashed at rest. Cooldown
// (60s between sends) and the 24h send quota are computed by counting
// rows — no Redis, so state survives restarts and the whole flow runs
// under the pglite test harness (the tax-share OTP stalled on "Redis
// wiring later"; this module is why we don't repeat that).
//
// Lockout ladder: 5 wrong attempts lock the active challenge (the
// recipient can request a fresh code); 3 exhausted challenges signal
// the caller to revoke the share outright (15 total wrong digits is
// guessing, not fat-fingering).

import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { fileShareOtps, type FileShare } from '@vibe/db/schema';
import { generateSmsOtp, hashSmsOtp } from '@vibe/core/auth';

export const OTP_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60_000;
export const MAX_SENDS_PER_24H = 10;
export const MAX_LOCKED_CHALLENGES = 3;
export const GRANT_TTL_MS = 30 * 60_000; // step-up convention (Q4)

export type OtpChannel = 'EMAIL' | 'SMS';

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, 2)}${'*'.repeat(phone.length - 4)}${phone.slice(-2)}`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export type CreateChallengeResult =
  | { ok: true; code: string; channel: OtpChannel; destination: string; maskedDestination: string }
  | { ok: false; error: 'cooldown'; retryAfterSeconds: number }
  | { ok: false; error: 'send_quota' }
  | { ok: false; error: 'no_destination' };

/**
 * Create a fresh challenge for the share, locking any prior active one
 * (a single live code at a time keeps verify unambiguous). Returns the
 * PLAINTEXT code exactly once — the caller dispatches it and must
 * never log it.
 */
export async function createOtpChallenge(
  db: Database,
  share: Pick<FileShare, 'id' | 'verifyChannel' | 'recipientEmail' | 'recipientPhone'>,
  now: Date = new Date(),
): Promise<CreateChallengeResult> {
  const channel: OtpChannel =
    share.verifyChannel === 'SMS' && share.recipientPhone ? 'SMS' : 'EMAIL';
  const destination = channel === 'SMS' ? share.recipientPhone : share.recipientEmail;
  if (!destination) return { ok: false, error: 'no_destination' };

  const recent = await db
    .select({ createdAt: fileShareOtps.createdAt })
    .from(fileShareOtps)
    .where(
      and(
        eq(fileShareOtps.fileShareId, share.id),
        gt(fileShareOtps.createdAt, new Date(now.getTime() - 24 * 3600_000)),
      ),
    )
    .orderBy(desc(fileShareOtps.createdAt));
  if (recent.length >= MAX_SENDS_PER_24H) return { ok: false, error: 'send_quota' };
  const newest = recent[0];
  if (newest && now.getTime() - newest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      error: 'cooldown',
      retryAfterSeconds: Math.ceil(
        (RESEND_COOLDOWN_MS - (now.getTime() - newest.createdAt.getTime())) / 1000,
      ),
    };
  }

  // Retire any prior live challenge so only one code verifies.
  await db
    .update(fileShareOtps)
    .set({ lockedAt: now })
    .where(
      and(
        eq(fileShareOtps.fileShareId, share.id),
        isNull(fileShareOtps.verifiedAt),
        isNull(fileShareOtps.lockedAt),
      ),
    );

  const code = generateSmsOtp();
  await db.insert(fileShareOtps).values({
    fileShareId: share.id,
    channel,
    codeHash: hashSmsOtp(code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    // Explicit (not defaultNow) so cooldown/quota math follows the
    // injected clock — production passes real now; tests time-travel.
    createdAt: now,
  });

  return {
    ok: true,
    code,
    channel,
    destination,
    maskedDestination: channel === 'SMS' ? maskPhone(destination) : maskEmail(destination),
  };
}

export type VerifyChallengeResult =
  | { ok: true; grant: string }
  | { ok: false; error: 'no_active_code' }
  | { ok: false; error: 'invalid_code'; attemptsRemaining: number }
  | { ok: false; error: 'locked'; shouldRevoke: boolean };

export async function verifyOtpChallenge(
  db: Database,
  shareId: string,
  code: string,
  now: Date = new Date(),
): Promise<VerifyChallengeResult> {
  const [challenge] = await db
    .select()
    .from(fileShareOtps)
    .where(
      and(
        eq(fileShareOtps.fileShareId, shareId),
        isNull(fileShareOtps.verifiedAt),
        isNull(fileShareOtps.lockedAt),
        gt(fileShareOtps.expiresAt, now),
      ),
    )
    .orderBy(desc(fileShareOtps.createdAt))
    .limit(1);
  if (!challenge) return { ok: false, error: 'no_active_code' };

  if (hashSmsOtp(code) !== challenge.codeHash) {
    const [updated] = await db
      .update(fileShareOtps)
      .set({
        attempts: sql`${fileShareOtps.attempts} + 1`,
        lockedAt: sql`CASE WHEN ${fileShareOtps.attempts} + 1 >= ${MAX_ATTEMPTS} THEN ${now.toISOString()}::timestamptz ELSE NULL END`,
      })
      .where(eq(fileShareOtps.id, challenge.id))
      .returning({ attempts: fileShareOtps.attempts, lockedAt: fileShareOtps.lockedAt });
    const locked = updated!.lockedAt != null;
    if (!locked) {
      return {
        ok: false,
        error: 'invalid_code',
        attemptsRemaining: MAX_ATTEMPTS - updated!.attempts,
      };
    }
    const lockedRows = await db
      .select({ id: fileShareOtps.id })
      .from(fileShareOtps)
      .where(
        and(
          eq(fileShareOtps.fileShareId, shareId),
          sql`${fileShareOtps.lockedAt} IS NOT NULL`,
          sql`${fileShareOtps.attempts} >= ${MAX_ATTEMPTS}`,
        ),
      );
    return { ok: false, error: 'locked', shouldRevoke: lockedRows.length >= MAX_LOCKED_CHALLENGES };
  }

  const grant = randomBytes(32).toString('base64url');
  await db
    .update(fileShareOtps)
    .set({
      verifiedAt: now,
      grantTokenHash: sha256(grant),
      grantExpiresAt: new Date(now.getTime() + GRANT_TTL_MS),
    })
    .where(eq(fileShareOtps.id, challenge.id));
  return { ok: true, grant };
}

/** Does the raw grant cookie value unlock this share right now? */
export async function verifyGrant(
  db: Database,
  shareId: string,
  rawGrant: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!rawGrant || rawGrant.length < 20 || rawGrant.length > 200) return false;
  const [row] = await db
    .select({ id: fileShareOtps.id })
    .from(fileShareOtps)
    .where(
      and(
        eq(fileShareOtps.fileShareId, shareId),
        eq(fileShareOtps.grantTokenHash, sha256(rawGrant)),
        gt(fileShareOtps.grantExpiresAt, now),
      ),
    )
    .limit(1);
  return row != null;
}
