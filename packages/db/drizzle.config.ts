// SPDX-License-Identifier: Elastic-2.0
import type { Config } from 'drizzle-kit';

export default {
  schema: './src/schema/index.ts',
  out: './migrations',
  // drizzle-kit 0.21+ replaced the legacy `driver: 'pg'` +
  // `dbCredentials.connectionString` shape with `dialect` + `url`.
  // Only affects `drizzle-kit studio`; runtime migrations are applied by
  // src/scripts/migrate.ts (hand-written SQL), not drizzle-kit.
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgresql://vibe:vibe@localhost:5432/vibe_tb',
  },
  strict: true,
  verbose: true,
} satisfies Config;
