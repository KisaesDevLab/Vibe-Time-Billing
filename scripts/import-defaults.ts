// SPDX-License-Identifier: Elastic-2.0
//
// One-off: seed a firm's catalog with the shipped system template defaults,
// using the same clone engine the API uses. Run with:
//   DATABASE_URL=... FIRM_ID=... APP_USER_ID=... npx tsx scripts/import-defaults.ts

import { createDb } from '@vibe/db';

import {
  importEmails,
  importPackages,
  importServices,
  importTerms,
} from '../apps/api/src/template-library/clone';

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  const firmId = process.env['FIRM_ID'];
  const appUserId = process.env['APP_USER_ID'];
  if (!connectionString || !firmId || !appUserId) {
    throw new Error('DATABASE_URL, FIRM_ID, APP_USER_ID are required');
  }

  const { db, close } = createDb({ connectionString });
  try {
    const services = await importServices(db, { firmId, appUserId });
    const terms = await importTerms(db, { firmId, appUserId });
    const packages = await importPackages(db, { firmId, appUserId });
    const emails = await importEmails(db, { firmId });
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          services: {
            imported: services.imported,
            skipped: services.skipped,
            total: services.total,
          },
          terms,
          packages,
          emails,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
