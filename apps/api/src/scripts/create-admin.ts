// SPDX-License-Identifier: Elastic-2.0
//
// Create (or update) a password-login admin user on the existing firm.
//
// The dev seed (seed.ts) inserts staff users but assigns no roles, so
// they have zero permissions and can't reach the admin UI. bootstrap-firm
// creates a proper admin but is idempotent on firm name, so it's a no-op
// once a firm exists. This script fills that gap for an already-seeded
// appliance: it ensures an `admin` role (full access via the RBAC
// `admin` template), attaches the user to it, sets an argon2id password,
// and enrolls Email OTP so password sign-in (which requires a second
// factor) works without a magic link.
//
// Usage (env-driven, mirrors bootstrap-firm):
//   DATABASE_URL=postgres://... \
//   ADMIN_EMAIL=admin@firm.example \
//   ADMIN_PASSWORD='a-strong-passphrase' \
//   ADMIN_NAME='Firm Administrator' \   # optional
//   tsx apps/api/src/scripts/create-admin.ts
//
// Re-running is safe: it upserts the role + membership and resets the
// password to the supplied value.

import { and, eq } from 'drizzle-orm';

import { createDb, schemaTables } from '@vibe/db';

import { hashPassword, checkPasswordPolicy } from '../auth/password';

const { firms, offices, appUsers, roles, userRoles } = schemaTables;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const email = (process.env['ADMIN_EMAIL'] ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`ADMIN_EMAIL must be a valid email (got: ${email})`);

  const password = process.env['ADMIN_PASSWORD'] ?? '';
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) throw new Error(`ADMIN_PASSWORD rejected: ${policy.reason}`);

  const fullName = (process.env['ADMIN_NAME'] ?? 'Firm Administrator').trim();

  const { db, close } = createDb({ connectionString: databaseUrl, max: 1 });
  try {
    const [firm] = await db.select({ id: firms.id }).from(firms).limit(1);
    if (!firm) throw new Error('no firm found — run the seed or bootstrap first');
    const firmId = firm.id;

    // A default office (app_user.default_office_id is set for consistency
    // with the rest of the app; not strictly required).
    const [office] =
      (await db
        .select({ id: offices.id })
        .from(offices)
        .where(and(eq(offices.firmId, firmId), eq(offices.isDefault, true)))
        .limit(1)) ?? [];
    const [anyOffice] = office
      ? [office]
      : await db
          .select({ id: offices.id })
          .from(offices)
          .where(eq(offices.firmId, firmId))
          .limit(1);
    const officeId = anyOffice?.id ?? null;

    // Ensure an `admin` role (RBAC maps role name → slug; `admin` =
    // full access).
    let [adminRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.firmId, firmId), eq(roles.name, 'admin')))
      .limit(1);
    if (!adminRole) {
      [adminRole] = await db
        .insert(roles)
        .values({ firmId, name: 'admin', systemFlag: true })
        .returning({ id: roles.id });
    }
    if (!adminRole) throw new Error('failed to ensure admin role');

    // Ensure the user.
    let [user] = await db
      .select({ id: appUsers.id })
      .from(appUsers)
      .where(and(eq(appUsers.firmId, firmId), eq(appUsers.email, email)))
      .limit(1);
    if (!user) {
      [user] = await db
        .insert(appUsers)
        .values({ firmId, email, fullName, defaultOfficeId: officeId })
        .returning({ id: appUsers.id });
      // eslint-disable-next-line no-console
      console.log(`create-admin: created user ${email}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`create-admin: user ${email} already exists — updating`);
    }
    if (!user) throw new Error('failed to ensure user');

    await db
      .insert(userRoles)
      .values({ appUserId: user.id, roleId: adminRole.id })
      .onConflictDoNothing();

    const passwordHash = await hashPassword(password);
    await db
      .update(appUsers)
      .set({
        passwordHash,
        passwordSetAt: new Date(),
        // Enroll Email OTP so password sign-in's mandatory second factor
        // is satisfied (codes go wherever MAIL_PROVIDER points).
        emailOtpEnrolledAt: new Date(),
        preferredSecondFactor: 'EMAIL',
        updatedAt: new Date(),
      })
      .where(eq(appUsers.id, user.id));

    // eslint-disable-next-line no-console
    console.log(
      `create-admin: ${email} ready — admin role + password + Email OTP. Sign in with password; the OTP code is delivered via the configured mail provider (MailHog in local).`,
    );
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('create-admin: failed —', err instanceof Error ? err.message : err);
  process.exit(1);
});
