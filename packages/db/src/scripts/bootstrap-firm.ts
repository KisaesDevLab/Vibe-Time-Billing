// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// First-boot firm bootstrapper. The repo's seed.ts is a fully-loaded
// dev fixture ("Granite Peak CPAs" with sample staff, clients,
// adjustments, etc.). For a real CPA appliance install we want the
// minimum so the operator can sign in via magic link and start using
// the firm-settings UI to configure everything else.
//
// Inputs (env-passed, not flags — easier to drive from install.sh):
//   FIRM_NAME      e.g. "Smith & Co CPAs"
//   ADMIN_EMAIL    the email the first admin will sign in with
//   ADMIN_NAME     display name for the admin user (optional)
//
// What we insert (idempotent on firm name):
//   1. firm + firm_settings
//   2. one office ("Headquarters", America/Chicago — firm changes later)
//   3. admin app_user with the given email
//   4. role(name='admin', system_flag=true) + user_role link
//   5. four service lines (Tax / Audit / Advisory / Bookkeeping)
//   6. StandardRate rate_code (otherwise time entries can't price)
//   7. default notification templates + retainer tier configs (helpers
//      already exist for these)
//
// Engagement types, work codes, reason codes, clients, additional
// staff, and rates are all left for the operator to configure post-
// install via the admin UI.

import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

import {
  appUsers,
  firmSettings,
  firms,
  offices,
  rateCodes,
  roles,
  serviceLines,
  userRoles,
} from '../schema/core';
import { seedNotificationTemplates } from '../seed-helpers/notification-templates';
import { seedRetainerTierConfigs } from '../seed-helpers/retainer-tier-configs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const firmName = (process.env['FIRM_NAME'] ?? '').trim();
  if (!firmName) throw new Error('FIRM_NAME is required (e.g. "Smith & Co CPAs")');

  const adminEmail = (process.env['ADMIN_EMAIL'] ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(adminEmail)) {
    throw new Error(`ADMIN_EMAIL must be a valid email (got: ${adminEmail || '<empty>'})`);
  }

  const adminName = (process.env['ADMIN_NAME'] ?? 'Firm Administrator').trim();

  // eslint-disable-next-line no-console
  console.log(`bootstrap: firm='${firmName}' admin='${adminEmail}'`);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  try {
    const existing = await db.select().from(firms).where(eq(firms.name, firmName)).limit(1);
    if (existing.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`bootstrap: firm '${firmName}' already exists — exiting cleanly`);
      return;
    }
    await db.transaction(async (tx) => {
      const [firmRow] = await tx
        .insert(firms)
        .values({ name: firmName, fiscalYearStartMonth: 1, defaultTermsDays: 30 })
        .returning({ id: firms.id });
      if (!firmRow) throw new Error('firm insert failed');
      const firmId = firmRow.id;

      await tx.insert(firmSettings).values({ firmId });

      const [officeRow] = await tx
        .insert(offices)
        .values({
          firmId,
          name: 'Headquarters',
          timezone: 'America/Chicago',
          isDefault: true,
        })
        .returning({ id: offices.id });
      if (!officeRow) throw new Error('office insert failed');

      const [adminUser] = await tx
        .insert(appUsers)
        .values({
          firmId,
          email: adminEmail,
          fullName: adminName,
          defaultOfficeId: officeRow.id,
        })
        .returning({ id: appUsers.id });
      if (!adminUser) throw new Error('admin user insert failed');

      const [adminRole] = await tx
        .insert(roles)
        .values({ firmId, name: 'admin', systemFlag: true })
        .returning({ id: roles.id });
      if (!adminRole) throw new Error('admin role insert failed');

      await tx.insert(userRoles).values({ appUserId: adminUser.id, roleId: adminRole.id });

      await tx.insert(serviceLines).values([
        { firmId, name: 'Tax', category: 'tax' as const, color: '#3b82f6' },
        { firmId, name: 'Audit', category: 'audit' as const, color: '#ef4444' },
        { firmId, name: 'Advisory', category: 'advisory' as const, color: '#22c55e' },
        { firmId, name: 'Bookkeeping', category: 'bookkeeping' as const, color: '#f59e0b' },
      ]);

      await tx.insert(rateCodes).values({
        firmId,
        code: 'StandardRate',
        description: 'Default billing rate',
        sortOrder: 0,
        isSystem: true,
      });

      const tplCount = await seedNotificationTemplates(tx, firmId);
      // eslint-disable-next-line no-console
      console.log(`bootstrap: seeded ${tplCount} notification template default(s)`);

      const tierCount = await seedRetainerTierConfigs(tx, firmId);
      // eslint-disable-next-line no-console
      console.log(`bootstrap: seeded ${tierCount} retainer tier config default(s)`);
    });
    // eslint-disable-next-line no-console
    console.log(`bootstrap: '${firmName}' ready. Sign in at the admin URL using ${adminEmail}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('bootstrap: failed —', err instanceof Error ? err.message : err);
  process.exit(1);
});

// Type used by seed-helpers (drizzle's transaction param shape).
export type Tx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0];
