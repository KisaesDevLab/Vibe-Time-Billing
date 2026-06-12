// SPDX-License-Identifier: Elastic-2.0
//
// Reset a staff user's password by app_user id. Companion to
// create-admin.ts (which upserts by email and also grants roles); this
// one only swaps the argon2id digest on an existing, explicitly
// identified user — no role or second-factor changes.
//
// Usage:
//   DATABASE_URL=postgres://... \
//   APP_USER_ID=<uuid> \
//   NEW_PASSWORD='a-strong-passphrase' \
//   tsx apps/api/src/scripts/reset-password.ts

import { eq } from 'drizzle-orm';

import { createDb, schemaTables } from '@vibe/db';

import { hashPassword, checkPasswordPolicy } from '../auth/password';

const { appUsers } = schemaTables;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const userId = (process.env['APP_USER_ID'] ?? '').trim();
  if (!UUID_RE.test(userId)) throw new Error(`APP_USER_ID must be a uuid (got: ${userId})`);

  const password = process.env['NEW_PASSWORD'] ?? '';
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new Error(`NEW_PASSWORD rejected: ${policy.reason}`);

  const { db, close } = createDb({ connectionString: databaseUrl, max: 1 });
  try {
    const [user] = await db
      .select({ id: appUsers.id, email: appUsers.email, status: appUsers.status })
      .from(appUsers)
      .where(eq(appUsers.id, userId))
      .limit(1);
    if (!user) throw new Error(`no app_user with id ${userId}`);

    const passwordHash = await hashPassword(password);
    await db
      .update(appUsers)
      .set({ passwordHash, passwordSetAt: new Date(), updatedAt: new Date() })
      .where(eq(appUsers.id, user.id));

    // eslint-disable-next-line no-console
    console.log(
      `reset-password: password updated for ${user.email} (${user.id}, status ${user.status}). ` +
        'Existing sessions are untouched; sign-in still requires the enrolled second factor.',
    );
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('reset-password: failed —', err instanceof Error ? err.message : err);
  process.exit(1);
});
