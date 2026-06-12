// SPDX-License-Identifier: Elastic-2.0
//
// 0102 — unified secure file sharing. Brings the tax-return share model to
// any file: argon2 token (`<shareId>.<secret>`), recipient capture,
// expiry cap, rate limits, revoke, status + view tracking, and link
// delivery. Used by both the staff and portal create paths and the public
// redeem route. (2FA fields are stored; enforcement is a phased follow-up.)

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import { fileShares, fileShareItems } from '@vibe/db/schema';
import { hashPassword, verifyPassword } from '@vibe/crypto';

export const MAX_SHARE_DAYS = 90;
const DEFAULT_SHARE_DAYS = 30;
const MAX_ACTIVE_PER_ACTOR_24H = 50;
const MAX_ACTIVE_PER_RECIPIENT = 5;

export type ShareAccessLevel = 'view' | 'download';
export type ShareVerifyChannel = 'NONE' | 'EMAIL' | 'SMS';

export interface CreateFileShareInput {
  firmId: string;
  clientId: string;
  /** NULL for a bundle share (files live in file_share_item). */
  fileId: string | null;
  createdByAppUserId?: string | null;
  createdByPortalIdentityId?: string | null;
  accessLevel: ShareAccessLevel;
  recipientName?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  organization?: string | null;
  role?: string | null;
  personalMessage?: string | null;
  require2fa?: boolean;
  verifyChannel?: ShareVerifyChannel;
  watermark?: boolean;
  note?: string | null;
  /** Requested expiry; capped to MAX_SHARE_DAYS. Defaults to 30 days. */
  expiresAt?: Date | null;
  now?: Date;
}

export type CreateFileShareResult =
  | { ok: true; shareId: string; token: string; expiresAt: Date }
  | { ok: false; error: 'rate_limited_actor' | 'rate_limited_recipient' };

/** Cap an expiry to [now, now + MAX_SHARE_DAYS]; default 30 days out. */
function capExpiry(requested: Date | null | undefined, now: Date): Date {
  const max = new Date(now.getTime() + MAX_SHARE_DAYS * 86_400_000);
  if (!requested) return new Date(now.getTime() + DEFAULT_SHARE_DAYS * 86_400_000);
  if (requested.getTime() > max.getTime()) return max;
  if (requested.getTime() < now.getTime()) return new Date(now.getTime() + 86_400_000);
  return requested;
}

export async function createFileShare(
  db: Database,
  input: CreateFileShareInput,
): Promise<CreateFileShareResult> {
  const now = input.now ?? new Date();

  // Rate limit: per-actor creations in the last 24h.
  const actorCol = input.createdByAppUserId
    ? eq(fileShares.createdByAppUserId, input.createdByAppUserId)
    : input.createdByPortalIdentityId
      ? eq(fileShares.createdByPortalIdentityId, input.createdByPortalIdentityId)
      : null;
  if (actorCol) {
    const since = new Date(now.getTime() - 86_400_000);
    const actorRows = await db
      .select({ n: count() })
      .from(fileShares)
      .where(and(eq(fileShares.firmId, input.firmId), actorCol, gte(fileShares.createdAt, since)));
    if (Number(actorRows[0]?.n ?? 0) >= MAX_ACTIVE_PER_ACTOR_24H) {
      return { ok: false, error: 'rate_limited_actor' };
    }
  }
  // Rate limit: active shares to the same recipient email.
  if (input.recipientEmail) {
    const recRows = await db
      .select({ n: count() })
      .from(fileShares)
      .where(
        and(
          eq(fileShares.firmId, input.firmId),
          eq(fileShares.recipientEmail, input.recipientEmail.toLowerCase()),
          inArray(fileShares.status, ['SENT', 'VIEWED']),
          sql`${fileShares.revokedAt} IS NULL`,
        ),
      );
    if (Number(recRows[0]?.n ?? 0) >= MAX_ACTIVE_PER_RECIPIENT) {
      return { ok: false, error: 'rate_limited_recipient' };
    }
  }

  const shareId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const token = `${shareId}.${secret}`;
  const tokenHash = await hashPassword(secret);
  const expiresAt = capExpiry(input.expiresAt, now);

  await db.insert(fileShares).values({
    // 0150 — all new shares are gated (explicit; not just the DDL default).
    gated: true,
    id: shareId,
    firmId: input.firmId,
    clientId: input.clientId,
    fileId: input.fileId,
    createdByAppUserId: input.createdByAppUserId ?? null,
    createdByPortalIdentityId: input.createdByPortalIdentityId ?? null,
    tokenHash,
    accessLevel: input.accessLevel,
    expiresAt,
    note: input.note ?? null,
    recipientName: input.recipientName ?? null,
    recipientEmail: input.recipientEmail?.toLowerCase() ?? null,
    recipientPhone: input.recipientPhone ?? null,
    organization: input.organization ?? null,
    role: input.role ?? null,
    personalMessage: input.personalMessage ?? null,
    require2fa: input.require2fa ?? false,
    verifyChannel: input.verifyChannel ?? 'NONE',
    watermark: input.watermark ?? false,
    status: 'SENT',
  });

  return { ok: true, shareId, token, expiresAt };
}

export interface CreateFileShareBundleInput extends Omit<CreateFileShareInput, 'fileId'> {
  /** The files to bundle behind one link (≥1). */
  fileIds: string[];
}

/**
 * 0154 — create a combined (bundle) share: one file_share row with
 * file_id NULL + one file_share_item per file. Same token/rate-limit/
 * gate model as a single-file share; the landing page lists all files.
 */
export async function createFileShareBundle(
  db: Database,
  input: CreateFileShareBundleInput,
): Promise<CreateFileShareResult> {
  const now = input.now ?? new Date();
  // Reuse the single-file create for token + rate-limit + row insert,
  // passing fileId null; then attach the item rows.
  const base = await createFileShare(db, { ...input, fileId: null, now });
  if (!base.ok) return base;
  const seen = new Set<string>();
  for (const fid of input.fileIds) {
    if (seen.has(fid)) continue;
    seen.add(fid);
    await db.insert(fileShareItems).values({ fileShareId: base.shareId, fileId: fid });
  }
  return base;
}

/** File ids covered by a share: the bundle items, or the single file_id. */
export async function fileShareFileIds(db: Database, share: ResolvedFileShare): Promise<string[]> {
  if (share.fileId) return [share.fileId];
  const items = await db
    .select({ fileId: fileShareItems.fileId })
    .from(fileShareItems)
    .where(eq(fileShareItems.fileShareId, share.id));
  return items.map((i) => i.fileId);
}

export type ResolvedFileShare = typeof fileShares.$inferSelect;

/**
 * Resolve a token to its share row. Supports the new dotted argon2 token
 * (`<shareId>.<secret>`) and legacy 64-hex sha256 tokens. Returns null on
 * any mismatch (no information leak).
 */
export async function resolveFileShareToken(
  db: Database,
  token: string,
): Promise<ResolvedFileShare | null> {
  if (token.includes('.')) {
    const dot = token.indexOf('.');
    const idPart = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    if (!idPart || !secret) return null;
    const [row] = await db.select().from(fileShares).where(eq(fileShares.id, idPart)).limit(1);
    if (!row) return null;
    const ok = await verifyPassword(row.tokenHash, secret);
    return ok ? row : null;
  }
  // Legacy sha256 token.
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await db.select().from(fileShares).where(eq(fileShares.tokenHash, hash)).limit(1);
  return row ?? null;
}

export async function markFileShareViewed(db: Database, shareId: string): Promise<void> {
  await db
    .update(fileShares)
    .set({
      accessCount: sql`${fileShares.accessCount} + 1`,
      lastAccessedAt: new Date(),
      firstViewedAt: sql`COALESCE(${fileShares.firstViewedAt}, now())`,
      lastViewedAt: new Date(),
      status: sql`CASE WHEN ${fileShares.status} = 'SENT' THEN 'VIEWED' ELSE ${fileShares.status} END`,
    })
    .where(eq(fileShares.id, shareId));
}

export async function revokeFileShare(db: Database, shareId: string): Promise<void> {
  await db
    .update(fileShares)
    .set({ revokedAt: new Date(), status: 'REVOKED' })
    .where(eq(fileShares.id, shareId));
}

export interface DeliverShareArgs {
  sendEmail?: (m: { to: string; subject: string; body: string }) => Promise<unknown>;
  sendSms?: (m: { to: string; body: string }) => Promise<unknown>;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  verifyChannel?: string | null;
  recipientName?: string | null;
  personalMessage?: string | null;
  senderLabel: string; // firm or client name
  link: string;
  expiresAt: Date;
}

/** Email (and optionally SMS) the share link to the recipient. Best-effort
 *  per channel; returns which channels were dispatched. Never logs the link
 *  body beyond the dispatcher itself. */
export async function deliverShare(
  args: DeliverShareArgs,
): Promise<{ emailed: boolean; smsed: boolean }> {
  let emailed = false;
  let smsed = false;
  const expiry = args.expiresAt.toISOString().slice(0, 10);
  if (args.sendEmail && args.recipientEmail) {
    const subject = `${args.senderLabel} shared a secure document with you`;
    const body = [
      args.recipientName ? `Hi ${args.recipientName},` : 'Hello,',
      '',
      `${args.senderLabel} has shared a document with you securely.`,
      args.personalMessage ? `\n${args.personalMessage}\n` : '',
      `View it here (expires ${expiry}):`,
      args.link,
      '',
      "When you open the page, you'll receive a one-time access code at this address to unlock the document.",
      '',
      'This link is private — please do not forward it.',
    ]
      .filter((l) => l !== '')
      .join('\n');
    await args.sendEmail({ to: args.recipientEmail, subject, body });
    emailed = true;
  }
  if (args.sendSms && args.recipientPhone && args.verifyChannel === 'SMS') {
    await args.sendSms({
      to: args.recipientPhone,
      body: `${args.senderLabel} shared a secure document: ${args.link} (expires ${expiry}). You'll get an access code when you open it.`,
    });
    smsed = true;
  }
  return { emailed, smsed };
}
